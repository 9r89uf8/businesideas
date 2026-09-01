export const X_FOR_YOU_ERROR_CODES = Object.freeze({
  FEATURE_DISABLED: "FEATURE_DISABLED",
  CONFIG_INVALID: "CONFIG_INVALID",
  RUNTIME_PATH_UNSAFE: "RUNTIME_PATH_UNSAFE",
  APPROVED_ACCOUNT_MISMATCH: "APPROVED_ACCOUNT_MISMATCH",
  PROFILE_LOCKED: "PROFILE_LOCKED",
  PROFILE_LOCK_INVALID: "PROFILE_LOCK_INVALID",
  BROWSER_LAUNCH_ALREADY_CLAIMED: "BROWSER_LAUNCH_ALREADY_CLAIMED",
  VERIFIED_CAPABILITY_REQUIRED: "VERIFIED_CAPABILITY_REQUIRED",
  AWS_CONFIGURATION_INVALID: "AWS_CONFIGURATION_INVALID",
  AWS_SECRET_UNAVAILABLE: "AWS_SECRET_UNAVAILABLE",
  AWS_RESULT_DELIVERY_FAILED: "AWS_RESULT_DELIVERY_FAILED",
});

/**
 * A deliberately small error surface for the X web collector. Messages never
 * include environment values, credentials, or runtime paths.
 */
export class XForYouSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XForYouSafetyError";
    this.code = code;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

export function isXForYouSafetyError(error, code) {
  return (
    error instanceof XForYouSafetyError &&
    (code === undefined || error.code === code)
  );
}
