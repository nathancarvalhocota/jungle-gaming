export class WalletAlreadyExistsError extends Error {
  override name = "WalletAlreadyExistsError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class WalletNotFoundError extends Error {
  override name = "WalletNotFoundError";
}

export class InvalidWalletInputError extends Error {
  override name = "InvalidWalletInputError";
}

export class UnsupportedWalletCurrencyError extends Error {
  override name = "UnsupportedWalletCurrencyError";
}
