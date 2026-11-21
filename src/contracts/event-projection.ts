import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

/** An indexed contract event as the projection services receive it. */
export interface ProjectionEvent {
  /** Stable, unique id of the event within its stream. */
  readonly id: string;
  readonly ledger: number;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Applies an event to a projection exactly once.
 *
 * The `ContractEventApplied` claim and the handler's writes share one
 * transaction, so a failing handler leaves the event unclaimed and retryable,
 * and a replayed event (live ingestion plus backfill) is a no-op. This is the
 * same admission rule `ContractEventGapService.applyEventOnce` uses.
 *
 * @returns true when the event was applied, false when it was already applied.
 */
export async function applyProjectionEventOnce(
  prisma: PrismaService,
  streamKey: string,
  event: ProjectionEvent,
  handler: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.contractEventApplied.create({
        data: { streamKey, eventId: event.id, ledger: event.ledger },
      });
      await handler(tx);
      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}
