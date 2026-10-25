import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Inject,
} from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import {
  InvalidWalletInputError,
  OpeningBalanceNotAvailableError,
  UnsupportedWalletCurrencyError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../application/wallet.errors.ts";

@Catch()
export class WalletHttpErrorFilter extends BaseExceptionFilter {
  constructor(@Inject(HttpAdapterHost) adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<{ url?: string }>();
    if (!isWalletRoute(request.url ?? "")) {
      super.catch(error, host);
      return;
    }
    if (error instanceof HttpException && error.getStatus() !== 400) {
      super.catch(error, host);
      return;
    }
    const response = host.switchToHttp().getResponse();
    const mapped = mapWalletError(error);
    response.status(mapped.statusCode).json({
      statusCode: mapped.statusCode,
      code: mapped.code,
      message: mapped.message,
    });
  }
}

function isWalletRoute(url: string): boolean {
  return /^\/wallets(?:\/|\?|$)/.test(url);
}

function mapWalletError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (
    error instanceof InvalidWalletInputError ||
    error instanceof HttpException
  ) {
    return {
      statusCode: 400,
      code: "INVALID_WALLET_INPUT",
      message: "Wallet input is invalid",
    };
  }
  if (error instanceof UnsupportedWalletCurrencyError) {
    return {
      statusCode: 400,
      code: "UNSUPPORTED_CURRENCY",
      message: "Only BRL is available",
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return {
      statusCode: 409,
      code: "WALLET_ALREADY_EXISTS",
      message: "Wallet already exists",
    };
  }
  if (error instanceof WalletNotFoundError) {
    return {
      statusCode: 404,
      code: "WALLET_NOT_FOUND",
      message: "Wallet was not found",
    };
  }
  if (error instanceof OpeningBalanceNotAvailableError) {
    return {
      statusCode: 422,
      code: "OPENING_BALANCE_NOT_AVAILABLE",
      message: "Positive opening balance is not available yet",
    };
  }
  if (isUnavailableDatabaseError(error)) {
    return {
      statusCode: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "Database is temporarily unavailable",
    };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error",
  };
}

function isUnavailableDatabaseError(
  error: unknown,
  visited = new Set<unknown>(),
): boolean {
  if (typeof error !== "object" || error === null || visited.has(error))
    return false;
  visited.add(error);
  const record = error as Record<string, unknown>;
  if (
    typeof record.code === "string" &&
    (/^(?:08[0-9A-Z]{3}|53[0-9A-Z]{3}|57P0[123])$/.test(record.code) ||
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EPIPE",
      ].includes(record.code))
  ) {
    return true;
  }
  return "cause" in record && isUnavailableDatabaseError(record.cause, visited);
}
