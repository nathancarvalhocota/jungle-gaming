import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { WalletUseCases } from "../application/wallet.use-cases.ts";

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(WalletUseCases) private readonly walletUseCases: WalletUseCases,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    return this.walletUseCases.create(body);
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.walletUseCases.get(walletId);
  }
}
