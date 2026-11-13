/**
 * The provider's list of models, as the parent area's picker shows it. Everything here comes
 * from the provider's answer, so it is cleaned before it reaches the screen: only the fields
 * below are kept, texts are cut and stripped of control characters, and anything of the
 * wrong type is dropped. Nothing of it is sent anywhere or stored, except the name of the
 * model the parent picks (and whether it is uncensored), in the settings.
 * Docs: https://docs.venice.ai/api-reference/endpoint/models/list
 */

export type ModelKind = 'text' | 'image';

/** In USD for a million tokens: the cheapest and the dearest of input, output and the two cache prices. */
export interface PriceRange {
  min: number;
  max: number;
}

export interface ModelInfo {
  /** The name a call is made with. */
  id: string;
  /** The name shown to the parent. */
  name: string;
  kind: ModelKind;
  /** "private": the provider keeps nothing. "anonymized": the model's own company sees the text, not who sent it. */
  privacy: 'private' | 'anonymized' | null;
  /** The provider marks it as uncensored: offered only in a parent's own use. */
  uncensored: boolean;
  /** Runs in a trusted execution environment that can be attested. */
  tee: boolean;
  /** Supports end-to-end encryption. The app itself makes ordinary calls. */
  e2ee: boolean;
  /** Can search the web: what search mode needs. */
  webSearch: boolean;
  /** Can read pictures: what a model for attached files needs. */
  vision: boolean;
  /** Absent from the provider's answer for some models (and for image models, which are priced per picture). */
  price: PriceRange | null;
}

/** The parent area's model fields: one per mode, and the one for attached files. */
export type ModelField = 'chat' | 'search' | 'math' | 'draw' | 'files';

/** More models than this in one answer are not kept. */
export const MAX_MODELS = 1_000;
/** As long as a model name in the settings may be (src/storage/settings.ts). */
export const MAX_MODEL_ID_CHARS = 200;
export const MAX_MODEL_NAME_CHARS = 80;

/** Printable ASCII with no spaces: what a model's name in a call looks like. */
const MODEL_ID = /^[\x21-\x7e]+$/;

/** A control character, or a mark that changes the direction of the text around it. */
function unshown(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x61c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** A name from the provider as it may be shown: no control or direction characters, cut short. */
function shownName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = '';
  // Only the start of an over-long name is looked at.
  for (let at = 0; at < Math.min(value.length, MAX_MODEL_NAME_CHARS * 4); at += 1) {
    if (!unshown(value.charCodeAt(at))) name += value[at];
  }
  return name.trim().slice(0, MAX_MODEL_NAME_CHARS);
}

/**
 * A model's name says it is uncensored ("venice-uncensored", "...-abliterated"). For a name
 * the parent typed by hand, which has no mark from the provider's list.
 */
export function looksUncensored(model: string): boolean {
  return /uncensored|abliterat/i.test(model);
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function priceOf(pricing: unknown): PriceRange | null {
  const prices = ['input', 'output', 'cache_input', 'cache_write']
    .map((part) => record(record(pricing)[part]).usd)
    .filter((usd): usd is number => typeof usd === 'number' && Number.isFinite(usd) && usd >= 0);
  return prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

/**
 * Makes the picker's list out of the provider's answer (`{ data: [...] }`) to a request for
 * one kind of model. Offline models are left out, and so is anything that is not a model of
 * that kind with a usable name. Never throws.
 */
export function sanitizeModels(raw: unknown, kind: ModelKind): ModelInfo[] {
  const data = record(raw).data;
  if (!Array.isArray(data)) return [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (models.length >= MAX_MODELS) break;
    const { id, type, model_spec } = record(entry);
    if (typeof id !== 'string' || id.length > MAX_MODEL_ID_CHARS || !MODEL_ID.test(id) || seen.has(id)) continue;
    if (type !== undefined && type !== kind) continue;
    const spec = record(model_spec);
    if (spec.offline === true) continue;
    const capabilities = record(spec.capabilities);
    const name = shownName(spec.name);
    seen.add(id);
    models.push({
      id,
      name: name || id,
      kind,
      privacy: spec.privacy === 'private' || spec.privacy === 'anonymized' ? spec.privacy : null,
      uncensored: spec.uncensored === true || looksUncensored(id),
      tee: capabilities.supportsTeeAttestation === true,
      e2ee: capabilities.supportsE2EE === true,
      webSearch: capabilities.supportsWebSearch === true,
      vision: capabilities.supportsVision === true,
      price: kind === 'text' ? priceOf(spec.pricing) : null,
    });
  }
  return models;
}

/**
 * The models a field can use: image models for drawing and text models elsewhere, only
 * models that search the web for search mode, only models that read pictures for attached
 * files. Uncensored models are offered only when `withUncensored` (a parent's own use).
 */
export function modelsFor(field: ModelField, models: readonly ModelInfo[], withUncensored: boolean): ModelInfo[] {
  return models.filter(
    (model) =>
      model.kind === (field === 'draw' ? 'image' : 'text') &&
      (field !== 'search' || model.webSearch) &&
      (field !== 'files' || model.vision) &&
      (withUncensored || !model.uncensored),
  );
}

/** The models whose name or call name holds every word that was typed, in any letter case. */
export function filterModels(models: readonly ModelInfo[], typed: string): ModelInfo[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const names = `${model.name} ${model.id}`.toLowerCase();
    return words.every((word) => names.includes(word));
  });
}

/** Two digits after the dot; a price under a cent keeps its first two digits instead of becoming 0.00. */
function amount(usd: number): string {
  if (usd === 0 || usd >= 0.01) return usd.toFixed(2);
  const small = Number(usd.toPrecision(2))
    .toFixed(10)
    .replace(/0+$/, '');
  // Too small to show in ten digits: nothing, for any real use.
  return small.endsWith('.') ? '0.00' : small;
}

/** "USD 0.03-1.25 / 1M": the price range for a million tokens, cache included. */
export function priceText(price: PriceRange): string {
  const range = price.min === price.max ? amount(price.min) : `${amount(price.min)}-${amount(price.max)}`;
  return `USD ${range} / 1M`;
}
