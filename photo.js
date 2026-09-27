// Trip cover photos. Photos are shrunk on the device to a JPEG of at most
// MAX_PHOTO_CHARS characters (as a data URL) and stored in the trip's own
// database, so no separate file storage is needed.

export const MAX_PHOTO_CHARS = 240_000;

const PHOTO_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/** True for a data URL this app wrote; anything else is never put into the page. */
export const isPhotoDataUrl = (value) => typeof value === 'string' && value.length <= MAX_PHOTO_CHARS && PHOTO_PATTERN.test(value);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file couldn't be read as a photo."));
    img.src = src;
  });
}

/** Shrink an image file to a JPEG data URL small enough to store with the trip. */
export async function compressPhoto(file, maxChars = MAX_PHOTO_CHARS) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) throw new Error("That file couldn't be read as a photo.");
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (const edge of [1600, 1280, 1024, 800, 640]) {
      const scale = Math.min(1, edge / longest);
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.7, 0.6, 0.5]) {
        const data = canvas.toDataURL('image/jpeg', quality);
        if (data.length <= maxChars && isPhotoDataUrl(data)) return data;
      }
    }
    throw new Error("That photo couldn't be made small enough. Try a different one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
