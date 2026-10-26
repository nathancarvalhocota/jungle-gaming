import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { TransactionUseCases } from "../application/transaction.use-cases.ts";
import { WagerTransactionStatus } from "../domain/transactions/wager-transaction.ts";
@Controller()
export class TransactionController {
  constructor(
    @Inject(TransactionUseCases) private readonly useCases: TransactionUseCases,
  ) {}
  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: unknown,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ) {
    const result = await this.useCases.submit(body, key);
    response.status(
      result.status === WagerTransactionStatus.PendingReference
        ? 202
        : result.status === WagerTransactionStatus.Rejected
          ? 422
          : result.idempotentReplay
            ? 200
            : 201,
    );
    return result;
  }
  @Get("wagering/transactions/:transactionId")
  get(@Param("transactionId") id: string) {
    return this.useCases.get(id);
  }
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getExternal(
    @Param("providerId") provider: string,
    @Param("externalTransactionId") external: string,
  ) {
    return this.useCases.getExternal(provider, external);
  }
}
