import { useCallback } from 'react';

/**
 * A picture kept as bytes on the phone. Its address lives only while it is on the screen:
 * it is made when the picture is put on the screen (before it is painted) and released when
 * the picture leaves it or its bytes change.
 */
export function BlobImage({ bytes, type, className, alt }: { bytes: ArrayBuffer; type: string; className: string; alt: string }) {
  const show = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      const address = URL.createObjectURL(new Blob([bytes], { type }));
      img.src = address;
      return () => URL.revokeObjectURL(address);
    },
    [bytes, type],
  );
  return <img ref={show} className={className} alt={alt} />;
}
