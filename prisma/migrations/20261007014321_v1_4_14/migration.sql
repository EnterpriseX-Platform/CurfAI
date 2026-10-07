-- CreateTable
CREATE TABLE "UserAttribute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAttribute_tenantId_name_idx" ON "UserAttribute"("tenantId", "name");

-- CreateIndex
CREATE INDEX "UserAttribute_tenantId_userId_idx" ON "UserAttribute"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAttribute_tenantId_userId_name_value_key" ON "UserAttribute"("tenantId", "userId", "name", "value");

-- AddForeignKey
ALTER TABLE "UserAttribute" ADD CONSTRAINT "UserAttribute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAttribute" ADD CONSTRAINT "UserAttribute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

