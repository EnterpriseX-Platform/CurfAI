-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_tenantId_fkey";

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "deletionPriorStatus" TEXT,
ADD COLUMN     "deletionPurgeAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerifyGrandfathered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityMigratedAt" TIMESTAMP(3),
ADD COLUMN     "keycloakSub" TEXT;

-- AlterTable
ALTER TABLE "LlmTokenUsage" ADD COLUMN     "buildId" TEXT;

-- AlterTable
ALTER TABLE "StrategistQuestion" ADD COLUMN     "checkpointJson" TEXT;

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnScreenPairingCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "onScreenId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnScreenPairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "keyEnc" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fastModel" TEXT,
    "thinkingOff" BOOLEAN NOT NULL DEFAULT false,
    "inputPer1M" DOUBLE PRECISION,
    "outputPer1M" DOUBLE PRECISION,
    "cacheReadPer1M" DOUBLE PRECISION,
    "trial" BOOLEAN NOT NULL DEFAULT false,
    "maxQueue" INTEGER,
    "maxWaitSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformTierModel" (
    "tier" TEXT NOT NULL,
    "platformModelId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTierModel_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "TenantEntitlement" (
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "limitsJson" TEXT NOT NULL DEFAULT '{}',
    "validUntil" TIMESTAMP(3),
    "reference" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEntitlement_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "WorkspaceExport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "filePath" TEXT,
    "sizeBytes" INTEGER,
    "fileCount" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceDeletion" (
    "id" TEXT NOT NULL,
    "targetTenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "auditPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "subjectEmail" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'self_service',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "handledBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformModelChange" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "platformModelId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformModelChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBrief" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "weekday" INTEGER,
    "minutes" INTEGER NOT NULL,
    "tz" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "recipientsJson" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunDay" TEXT,
    "lastRunId" TEXT,
    "lastDeliveredRunId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxItemState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "snoozedUntil" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxItemState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_createdAt_idx" ON "EmailVerificationToken"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnScreenPairingCode_codeHash_key" ON "OnScreenPairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "OnScreenPairingCode_tenantId_onScreenId_idx" ON "OnScreenPairingCode"("tenantId", "onScreenId");

-- CreateIndex
CREATE INDEX "StripeEvent_receivedAt_idx" ON "StripeEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "WorkspaceExport_tenantId_createdAt_idx" ON "WorkspaceExport"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceExport_status_expiresAt_idx" ON "WorkspaceExport"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDeletion_targetTenantId_key" ON "WorkspaceDeletion"("targetTenantId");

-- CreateIndex
CREATE INDEX "WorkspaceDeletion_status_purgeAt_idx" ON "WorkspaceDeletion"("status", "purgeAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_status_dueAt_idx" ON "DataSubjectRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_subjectUserId_idx" ON "DataSubjectRequest"("subjectUserId");

-- CreateIndex
CREATE INDEX "PlatformModelChange_status_tier_idx" ON "PlatformModelChange"("status", "tier");

-- CreateIndex
CREATE INDEX "AgentBrief_tenantId_enabled_idx" ON "AgentBrief"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "AgentBrief_enabled_lastStatus_idx" ON "AgentBrief"("enabled", "lastStatus");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItemState_tenantId_userId_itemKey_key" ON "InboxItemState"("tenantId", "userId", "itemKey");

-- CreateIndex
CREATE INDEX "RecentView_tenantId_userId_viewedAt_idx" ON "RecentView"("tenantId", "userId", "viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecentView_tenantId_userId_kind_refId_key" ON "RecentView"("tenantId", "userId", "kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "User_keycloakSub_key" ON "User"("keycloakSub");

-- CreateIndex
CREATE INDEX "LlmTokenUsage_buildId_idx" ON "LlmTokenUsage"("buildId");

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnScreenPairingCode" ADD CONSTRAINT "OnScreenPairingCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnScreenPairingCode" ADD CONSTRAINT "OnScreenPairingCode_onScreenId_fkey" FOREIGN KEY ("onScreenId") REFERENCES "OnScreenDisplay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformTierModel" ADD CONSTRAINT "PlatformTierModel_platformModelId_fkey" FOREIGN KEY ("platformModelId") REFERENCES "PlatformModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantEntitlement" ADD CONSTRAINT "TenantEntitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceExport" ADD CONSTRAINT "WorkspaceExport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBrief" ADD CONSTRAINT "AgentBrief_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItemState" ADD CONSTRAINT "InboxItemState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentView" ADD CONSTRAINT "RecentView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

