# Domínio de apostas

Vocabulário do processamento financeiro de apostas e das carteiras do projeto.

## Termos

**Money**:
Uma quantia monetária associada a uma moeda. Quantias de moedas diferentes não são intercambiáveis nem podem ser somadas ou comparadas diretamente.

**Wallet (carteira)**:
Carteira de um jogador em uma moeda, com o saldo atual disponível. Seu saldo não pode ser negativo, e cada alteração corresponde a um lançamento no ledger.

**WagerTransaction (transação de negócio)**:
Registro de uma operação financeira do domínio de apostas e de seu estado de processamento, como aposta, prêmio, perda, devolução ou reversão. Uma transação rejeitada ou uma operação LOSS não movimenta saldo nem gera lançamento.

**Ledger (histórico financeiro da carteira)**:
Conjunto dos lançamentos imutáveis de crédito e débito de uma carteira, a partir dos quais seu saldo pode ser reconstruído e conferido.

**WalletLedgerEntry (lançamento)**:
Registro individual e imutável de uma movimentação financeira vinculada a uma transação, com valor, moeda, direção e saldos anterior e posterior. Uma reversão gera um lançamento compensatório, sem alterar ou excluir o lançamento original.
