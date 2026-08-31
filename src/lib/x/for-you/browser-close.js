const BROWSER_CLOSE_TIMEOUT_MS = 15_000;

export function browserCloseError() {
  const error = new Error(
    "Chrome did not confirm collector shutdown; the profile lock was retained.",
  );
  error.code = "BROWSER_CLOSE_FAILED";
  return error;
}

export async function closeBrowserContext(
  context,
  {
    timeoutMs = BROWSER_CLOSE_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (!context) return false;
  let timer = null;

  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(browserCloseError()), timeoutMs);
        timer?.unref?.();
      }),
    ]);
    return true;
  } catch {
    throw browserCloseError();
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}
