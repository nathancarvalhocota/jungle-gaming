import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { LedgerUseCases } from "../application/ledger.use-cases.ts";
import { WalletUseCases } from "../application/wallet.use-cases.ts";

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(WalletUseCases) private readonly walletUseCases: WalletUseCases,
    @Inject(LedgerUseCases) private readonly ledgerUseCases: LedgerUseCases,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    return this.walletUseCases.create(body);
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.walletUseCases.get(walletId);
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    return this.ledgerUseCases.list(walletId, query);
  }
}
