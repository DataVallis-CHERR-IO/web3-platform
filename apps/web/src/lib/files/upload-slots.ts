// An upload holds its file in memory two to three times (up to ~30 MB for a
// 10 MB file) and the web container is small, so each instance handles only a
// few uploads at once. Further ones are told to retry.

export const MAX_CONCURRENT_UPLOADS = 2;

let active = 0;

/** Returns a release function, or null when every slot is taken. */
export function tryAcquireUploadSlot(): (() => void) | null {
  if (active >= MAX_CONCURRENT_UPLOADS) return null;
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
  };
}
