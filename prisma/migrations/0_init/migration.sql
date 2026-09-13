-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'individual',
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'platform_admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'community',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "stripeStatus" TEXT,
    "stripeCurrentPeriodEnd" TIMESTAMP(3),
    "briefConfigJson" TEXT DEFAULT '{}',
    "llmProvider" TEXT DEFAULT 'anthropic',
    "llmKeyEnc" TEXT,
    "llmModel" TEXT,
    "llmBaseUrl" TEXT,
    "llmFastModel" TEXT,
    "smtpConfigJson" TEXT,
    "llmCostThresholdMicroUsd" INTEGER DEFAULT 10000000,
    "llmCostLastNotifyAt" TIMESTAMP(3),
    "currency" TEXT,
    "region" TEXT,
    "anthropicKeyEnc" TEXT,
    "auditRetentionJson" TEXT DEFAULT '{}',
    "webhookSigningSecret" TEXT,
    "brandJson" TEXT DEFAULT '{}',
    "pdpaRecordJson" TEXT DEFAULT '{}',
    "bio" TEXT DEFAULT '',
    "coverUrl" TEXT,
    "lakeEngine" TEXT DEFAULT 'sqlite',
    "lakeEngineMigratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dedicatedInstance" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "preferencesJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'developer',
    "rolesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "definition" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "domain" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "isCurated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'sqlite',
    "connection" TEXT NOT NULL,
    "discoveredSchemaJson" TEXT,
    "visibleToRolesJson" TEXT NOT NULL DEFAULT '[]',
    "ownerUserId" TEXT,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "format" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "durationMs" INTEGER,
    "dataset" TEXT,
    "provenance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT,
    "reportName" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "xField" TEXT NOT NULL,
    "yField" TEXT NOT NULL,
    "metricLabel" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "targetDate" TIMESTAMP(3) NOT NULL,
    "predictedValue" DOUBLE PRECISION NOT NULL,
    "upperBound" DOUBLE PRECISION NOT NULL,
    "lowerBound" DOUBLE PRECISION NOT NULL,
    "actualValue" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "params" TEXT NOT NULL DEFAULT '{}',
    "recipients" TEXT NOT NULL DEFAULT '[]',
    "kind" TEXT NOT NULL DEFAULT 'delivery',
    "watcherConfigJson" TEXT,
    "deliveryConfigJson" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ReportVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "actionKind" TEXT NOT NULL,
    "rowJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response" TEXT,
    "durationMs" INTEGER,
    "userId" TEXT,
    "userEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "cellKey" TEXT,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "proofHash" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "parentId" TEXT,
    "mentionsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "scope" TEXT NOT NULL DEFAULT 'api',
    "scopedReportIds" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicShareToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicShareToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paramsJson" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicApp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "titleI18n" TEXT DEFAULT '{}',
    "descriptionI18n" TEXT DEFAULT '{}',
    "briefConfigJson" TEXT DEFAULT '{}',
    "viewsJson" TEXT NOT NULL DEFAULT '[]',
    "dataMode" TEXT,
    "authMode" TEXT NOT NULL DEFAULT 'public',
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "paramsJson" TEXT NOT NULL DEFAULT '[]',
    "accentColor" TEXT,
    "passwordHash" TEXT,
    "autoRefreshSec" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "reportIdsJson" TEXT NOT NULL DEFAULT '[]',
    "rotationSeconds" INTEGER NOT NULL DEFAULT 30,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "layout" TEXT NOT NULL DEFAULT 'carousel',
    "visibleToRolesJson" TEXT NOT NULL DEFAULT '[]',
    "ownerUserId" TEXT,
    "topKpisJson" TEXT NOT NULL DEFAULT '[]',
    "slotLayoutJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardKioskToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardKioskToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnScreenDisplay" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "reportIdsJson" TEXT NOT NULL DEFAULT '[]',
    "rotationSeconds" INTEGER NOT NULL DEFAULT 30,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "layout" TEXT NOT NULL DEFAULT 'carousel',
    "visibleToRolesJson" TEXT NOT NULL DEFAULT '[]',
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "OnScreenDisplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnScreenDisplayKioskToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "onScreenId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnScreenDisplayKioskToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snippet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "description" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceConfigJson" TEXT,
    "schemaJson" TEXT NOT NULL DEFAULT '[]',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "ownerUserId" TEXT,
    "visibleToRolesJson" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT,
    "domain" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "isCurated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LakeTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeIngestToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "LakeIngestToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterializedView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "cron" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "storageKind" TEXT NOT NULL DEFAULT 'table',
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastRowCount" INTEGER,
    "lastDurationMs" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "description" TEXT,
    "domain" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "isCurated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MaterializedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeBackup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "tableCountAtSnapshot" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'auto',
    "restoredFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "LakeBackup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakePull" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'replace',
    "requestJson" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastRowsAppended" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "LakePull_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmTokenUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreateTokens" INTEGER NOT NULL DEFAULT 0,
    "microCostUsd" INTEGER,
    "reportId" TEXT,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "errorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmTokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '',
    "signingSecret" TEXT NOT NULL,
    "payloadFormat" TEXT NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "authorTenantId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "sourceReportId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'general',
    "tags" TEXT NOT NULL DEFAULT '',
    "definitionJson" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'report',
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "searchTokensJson" TEXT NOT NULL DEFAULT '[]',
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'published',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LakeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LakeExternalTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "credentialsEnc" TEXT,
    "schemaJson" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT,
    "domain" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "isCurated" BOOLEAN NOT NULL DEFAULT false,
    "dbtMetaJson" TEXT,
    "lastQueriedAt" TIMESTAMP(3),
    "lastRowCountEstimate" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "LakeExternalTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "workspaceName" TEXT,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedByEmail" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "inviteTokenHash" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "inviteUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "scheduleCron" TEXT NOT NULL,
    "objects" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "leasedBy" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "objectName" TEXT NOT NULL,
    "cursorKind" TEXT NOT NULL,
    "cursorValue" TEXT NOT NULL,
    "rowsLastRun" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "connectionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrgMembership_organizationId_idx" ON "OrgMembership"("organizationId");

-- CreateIndex
CREATE INDEX "OrgMembership_userId_idx" ON "OrgMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMembership_userId_organizationId_key" ON "OrgMembership"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_stripeCustomerId_key" ON "Tenant"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_stripeSubscriptionId_key" ON "Tenant"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Tenant_organizationId_idx" ON "Tenant"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_tenantId_idx" ON "Membership"("tenantId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_tenantId_key" ON "Membership"("userId", "tenantId");

-- CreateIndex
CREATE INDEX "Report_tenantId_category_idx" ON "Report"("tenantId", "category");

-- CreateIndex
CREATE INDEX "Report_tenantId_createdAt_idx" ON "Report"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_tenantId_domain_idx" ON "Report"("tenantId", "domain");

-- CreateIndex
CREATE INDEX "DataSource_tenantId_idx" ON "DataSource"("tenantId");

-- CreateIndex
CREATE INDEX "DataSource_ownerUserId_idx" ON "DataSource"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_tenantId_name_key" ON "DataSource"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ReportRun_tenantId_createdAt_idx" ON "ReportRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportRun_reportId_createdAt_idx" ON "ReportRun"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "ForecastSnapshot_tenantId_status_targetDate_idx" ON "ForecastSnapshot"("tenantId", "status", "targetDate");

-- CreateIndex
CREATE INDEX "ForecastSnapshot_tenantId_blockId_idx" ON "ForecastSnapshot"("tenantId", "blockId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastSnapshot_reportId_blockId_yField_targetLabel_key" ON "ForecastSnapshot"("reportId", "blockId", "yField", "targetLabel");

-- CreateIndex
CREATE INDEX "Schedule_tenantId_enabled_idx" ON "Schedule"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "Schedule_reportId_idx" ON "Schedule"("reportId");

-- CreateIndex
CREATE INDEX "ReportVersion_tenantId_createdAt_idx" ON "ReportVersion"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportVersion_reportId_createdAt_idx" ON "ReportVersion"("reportId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVersion_reportId_version_key" ON "ReportVersion"("reportId", "version");

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "Role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_slug_key" ON "Role"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "ActionRun_tenantId_createdAt_idx" ON "ActionRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionRun_reportId_createdAt_idx" ON "ActionRun"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionRun_blockId_createdAt_idx" ON "ActionRun"("blockId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_tenantId_reportId_blockId_idx" ON "Comment"("tenantId", "reportId", "blockId");

-- CreateIndex
CREATE INDEX "Comment_tenantId_createdAt_idx" ON "Comment"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_createdAt_idx" ON "ApiKey"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_scope_idx" ON "ApiKey"("tenantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_tenantId_userId_idx" ON "PasswordResetToken"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicShareToken_token_key" ON "PublicShareToken"("token");

-- CreateIndex
CREATE INDEX "PublicShareToken_tenantId_reportId_idx" ON "PublicShareToken"("tenantId", "reportId");

-- CreateIndex
CREATE INDEX "SavedView_tenantId_reportId_idx" ON "SavedView"("tenantId", "reportId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_tenantId_reportId_name_key" ON "SavedView"("tenantId", "reportId", "name");

-- CreateIndex
CREATE INDEX "PublicApp_tenantId_reportId_idx" ON "PublicApp"("tenantId", "reportId");

-- CreateIndex
CREATE INDEX "PublicApp_slug_idx" ON "PublicApp"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PublicApp_tenantId_slug_key" ON "PublicApp"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_kind_idx" ON "AuditEvent"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_userId_idx" ON "AuditEvent"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Dashboard_tenantId_idx" ON "Dashboard"("tenantId");

-- CreateIndex
CREATE INDEX "Dashboard_ownerUserId_idx" ON "Dashboard"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Dashboard_tenantId_slug_key" ON "Dashboard"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardKioskToken_token_key" ON "DashboardKioskToken"("token");

-- CreateIndex
CREATE INDEX "DashboardKioskToken_tenantId_dashboardId_idx" ON "DashboardKioskToken"("tenantId", "dashboardId");

-- CreateIndex
CREATE INDEX "OnScreenDisplay_tenantId_idx" ON "OnScreenDisplay"("tenantId");

-- CreateIndex
CREATE INDEX "OnScreenDisplay_ownerUserId_idx" ON "OnScreenDisplay"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OnScreenDisplay_tenantId_slug_key" ON "OnScreenDisplay"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "OnScreenDisplayKioskToken_token_key" ON "OnScreenDisplayKioskToken"("token");

-- CreateIndex
CREATE INDEX "OnScreenDisplayKioskToken_tenantId_onScreenId_idx" ON "OnScreenDisplayKioskToken"("tenantId", "onScreenId");

-- CreateIndex
CREATE INDEX "Snippet_tenantId_kind_idx" ON "Snippet"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "Snippet_tenantId_createdAt_idx" ON "Snippet"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Snippet_tenantId_kind_name_key" ON "Snippet"("tenantId", "kind", "name");

-- CreateIndex
CREATE INDEX "LakeTable_tenantId_updatedAt_idx" ON "LakeTable"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "LakeTable_tenantId_sourceKind_idx" ON "LakeTable"("tenantId", "sourceKind");

-- CreateIndex
CREATE INDEX "LakeTable_tenantId_domain_idx" ON "LakeTable"("tenantId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "LakeTable_tenantId_name_key" ON "LakeTable"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "LakeIngestToken_prefix_key" ON "LakeIngestToken"("prefix");

-- CreateIndex
CREATE INDEX "LakeIngestToken_tenantId_tableName_idx" ON "LakeIngestToken"("tenantId", "tableName");

-- CreateIndex
CREATE INDEX "LakeIngestToken_tenantId_revokedAt_idx" ON "LakeIngestToken"("tenantId", "revokedAt");

-- CreateIndex
CREATE INDEX "MaterializedView_tenantId_enabled_idx" ON "MaterializedView"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "MaterializedView_tenantId_domain_idx" ON "MaterializedView"("tenantId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "MaterializedView_tenantId_name_key" ON "MaterializedView"("tenantId", "name");

-- CreateIndex
CREATE INDEX "LakeBackup_tenantId_createdAt_idx" ON "LakeBackup"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LakeBackup_tenantId_kind_idx" ON "LakeBackup"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "LakePull_tenantId_enabled_idx" ON "LakePull"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "LakePull_tenantId_tableName_idx" ON "LakePull"("tenantId", "tableName");

-- CreateIndex
CREATE INDEX "LlmTokenUsage_tenantId_createdAt_idx" ON "LlmTokenUsage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmTokenUsage_tenantId_kind_createdAt_idx" ON "LlmTokenUsage"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "LlmTokenUsage_tenantId_provider_createdAt_idx" ON "LlmTokenUsage"("tenantId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "LlmTokenUsage_reportId_idx" ON "LlmTokenUsage"("reportId");

-- CreateIndex
CREATE INDEX "Webhook_tenantId_enabled_idx" ON "Webhook"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_tenantId_name_key" ON "Webhook"("tenantId", "name");

-- CreateIndex
CREATE INDEX "WebhookDelivery_tenantId_createdAt_idx" ON "WebhookDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceTemplate_slug_key" ON "MarketplaceTemplate"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceTemplate_status_category_publishedAt_idx" ON "MarketplaceTemplate"("status", "category", "publishedAt");

-- CreateIndex
CREATE INDEX "MarketplaceTemplate_authorTenantId_idx" ON "MarketplaceTemplate"("authorTenantId");

-- CreateIndex
CREATE INDEX "MarketplaceTemplate_downloads_idx" ON "MarketplaceTemplate"("downloads");

-- CreateIndex
CREATE INDEX "MarketplaceTemplate_ratingAvg_idx" ON "MarketplaceTemplate"("ratingAvg");

-- CreateIndex
CREATE INDEX "LakeSnapshot_tenantId_tableName_createdAt_idx" ON "LakeSnapshot"("tenantId", "tableName", "createdAt");

-- CreateIndex
CREATE INDEX "LakeSnapshot_backupId_idx" ON "LakeSnapshot"("backupId");

-- CreateIndex
CREATE INDEX "LakeExternalTable_tenantId_format_idx" ON "LakeExternalTable"("tenantId", "format");

-- CreateIndex
CREATE INDEX "LakeExternalTable_tenantId_domain_idx" ON "LakeExternalTable"("tenantId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "LakeExternalTable_tenantId_name_key" ON "LakeExternalTable"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistRequest_email_key" ON "WaitlistRequest"("email");

-- CreateIndex
CREATE INDEX "WaitlistRequest_status_createdAt_idx" ON "WaitlistRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncConnection_tenantId_kind_idx" ON "SyncConnection"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "SyncJob_nextRunAt_enabled_idx" ON "SyncJob"("nextRunAt", "enabled");

-- CreateIndex
CREATE INDEX "SyncJob_connectionId_idx" ON "SyncJob"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_connectionId_objectName_key" ON "SyncCursor"("connectionId", "objectName");

-- CreateIndex
CREATE INDEX "SyncRun_jobId_startedAt_idx" ON "SyncRun"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_connectionId_startedAt_idx" ON "SyncRun"("connectionId", "startedAt");

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastSnapshot" ADD CONSTRAINT "ForecastSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastSnapshot" ADD CONSTRAINT "ForecastSnapshot_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionRun" ADD CONSTRAINT "ActionRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicShareToken" ADD CONSTRAINT "PublicShareToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicApp" ADD CONSTRAINT "PublicApp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardKioskToken" ADD CONSTRAINT "DashboardKioskToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardKioskToken" ADD CONSTRAINT "DashboardKioskToken_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnScreenDisplay" ADD CONSTRAINT "OnScreenDisplay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnScreenDisplayKioskToken" ADD CONSTRAINT "OnScreenDisplayKioskToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnScreenDisplayKioskToken" ADD CONSTRAINT "OnScreenDisplayKioskToken_onScreenId_fkey" FOREIGN KEY ("onScreenId") REFERENCES "OnScreenDisplay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeTable" ADD CONSTRAINT "LakeTable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeIngestToken" ADD CONSTRAINT "LakeIngestToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterializedView" ADD CONSTRAINT "MaterializedView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeBackup" ADD CONSTRAINT "LakeBackup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakePull" ADD CONSTRAINT "LakePull_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmTokenUsage" ADD CONSTRAINT "LlmTokenUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceTemplate" ADD CONSTRAINT "MarketplaceTemplate_authorTenantId_fkey" FOREIGN KEY ("authorTenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeSnapshot" ADD CONSTRAINT "LakeSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LakeExternalTable" ADD CONSTRAINT "LakeExternalTable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

