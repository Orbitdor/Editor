export class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}

export const notFound = (resource = "Resource") =>
  new ApiError(404, `${resource} not found`);