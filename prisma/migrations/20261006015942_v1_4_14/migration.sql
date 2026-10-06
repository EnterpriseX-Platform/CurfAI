-- DropIndex
DROP INDEX "PublicShareToken_token_key";

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "backupLeasedBy" TEXT,
ADD COLUMN     "backupLeasedUntil" TIMESTAMP(3),
ADD COLUMN     "execPolicyJson" TEXT,
ADD COLUMN     "lakeLockedBy" TEXT,
ADD COLUMN     "lakeLockedUntil" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PublicShareToken" DROP COLUMN "token",
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "onBehalfOfUserId" TEXT,
ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MaterializedView" ADD COLUMN     "leasedBy" TEXT,
ADD COLUMN     "leasedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LakePull" ADD COLUMN     "leasedBy" TEXT,
ADD COLUMN     "leasedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarketplaceTemplate" ADD COLUMN     "sourceActionTemplateId" TEXT;

-- CreateTable
CREATE TABLE "AppScenario" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valuesJson" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeImportMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "mappingJson" TEXT NOT NULL,
    "dateOrdersJson" TEXT,
    "lastFilename" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LakeImportMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivationRunWrite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "previousEnc" TEXT,
    "undoneAt" TIMESTAMP(3),
    "undoError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationRunWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT '',
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "eventsJson" TEXT,
    "resultJson" TEXT,
    "errorJson" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "rowsAffected" INTEGER,
    "error" TEXT,
    "metaJson" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategistQuestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "planJson" TEXT,
    "researchJson" TEXT,
    "memoJson" TEXT,
    "contextJson" TEXT,
    "trackingJson" TEXT,
    "parentId" TEXT,
    "briefing" TEXT,
    "logJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategistQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategistDeckVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "overridesJson" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "parentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategistDeckVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyProfileVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyJson" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppScenario_tenantId_appId_idx" ON "AppScenario"("tenantId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "AppScenario_appId_name_key" ON "AppScenario"("appId", "name");

-- CreateIndex
CREATE INDEX "LakeImportMapping_tenantId_idx" ON "LakeImportMapping"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LakeImportMapping_tenantId_dataset_signature_key" ON "LakeImportMapping"("tenantId", "dataset", "signature");

-- CreateIndex
CREATE INDEX "ActivationRunWrite_tenantId_runId_idx" ON "ActivationRunWrite"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "ActivationRunWrite_runId_idx" ON "ActivationRunWrite"("runId");

-- CreateIndex
CREATE INDEX "AiJob_tenantId_createdAt_idx" ON "AiJob"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_tenantId_kind_targetId_startedAt_idx" ON "JobRun"("tenantId", "kind", "targetId", "startedAt");

-- CreateIndex
CREATE INDEX "StrategistQuestion_tenantId_createdById_updatedAt_idx" ON "StrategistQuestion"("tenantId", "createdById", "updatedAt");

-- CreateIndex
CREATE INDEX "StrategistQuestion_status_updatedAt_idx" ON "StrategistQuestion"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "StrategistDeckVersion_tenantId_questionId_createdAt_idx" ON "StrategistDeckVersion"("tenantId", "questionId", "createdAt");

-- CreateIndex
CREATE INDEX "CompanyProfileVersion_tenantId_createdAt_idx" ON "CompanyProfileVersion"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProfileVersion_tenantId_version_key" ON "CompanyProfileVersion"("tenantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PublicShareToken_tokenHash_key" ON "PublicShareToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "AppScenario" ADD CONSTRAINT "AppScenario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppScenario" ADD CONSTRAINT "AppScenario_appId_fkey" FOREIGN KEY ("appId") REFERENCES "PublicApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeImportMapping" ADD CONSTRAINT "LakeImportMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategistQuestion" ADD CONSTRAINT "StrategistQuestion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategistDeckVersion" ADD CONSTRAINT "StrategistDeckVersion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "StrategistQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProfileVersion" ADD CONSTRAINT "CompanyProfileVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

