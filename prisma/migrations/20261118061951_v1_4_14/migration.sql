-- CreateTable
CREATE TABLE "MembershipRemoval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipRemoval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipRemoval_tenantId_idx" ON "MembershipRemoval"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipRemoval_userId_tenantId_key" ON "MembershipRemoval"("userId", "tenantId");

