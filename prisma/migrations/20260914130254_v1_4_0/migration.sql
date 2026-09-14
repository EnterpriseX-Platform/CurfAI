-- AlterTable
ALTER TABLE "LlmTokenUsage" ADD COLUMN     "keySource" TEXT NOT NULL DEFAULT 'platform';

-- CreateIndex
CREATE INDEX "LlmTokenUsage_keySource_createdAt_idx" ON "LlmTokenUsage"("keySource", "createdAt");

