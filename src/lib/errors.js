/** An error that maps to an HTTP response with a stable machine-readable code. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const badRequest = (message, details) => new AppError(400, "invalid_request", message, details);
export const unauthorized = (message = "Missing or invalid API key") => new AppError(401, "unauthorized", message);
export const forbidden = (code, message) => new AppError(403, code, message);
export const notFound = (message = "Not found") => new AppError(404, "not_found", message);
export const conflict = (code, message) => new AppError(409, code, message);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);
