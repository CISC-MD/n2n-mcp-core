-- PostgreSQL Migration: High-Throughput Partitioned Ledger
-- Table: partitioned_usage_ledger (Partitioned by RANGE on transaction_date)

CREATE TABLE IF NOT EXISTS partitioned_usage_ledger (
    id UUID NOT NULL,
    client_id VARCHAR(255) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    context_id UUID,
    tokens_prompt INT DEFAULT 0,
    tokens_completion INT DEFAULT 0,
    compute_ms INT DEFAULT 0,
    cost_usd NUMERIC(12, 6) NOT NULL,
    transaction_date DATE NOT NULL,
    tenant_uuid UUID NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, transaction_date)
) PARTITION BY RANGE (transaction_date);

-- Composite index on tenant_uuid and client_id within partitions for fast slice query lookups
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_client ON partitioned_usage_ledger (tenant_uuid, client_id);

-- Pre-creating Range Partitions for 2026 and 2027
CREATE TABLE IF NOT EXISTS usage_ledger_2026_q1 PARTITION OF partitioned_usage_ledger
    FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS usage_ledger_2026_q2 PARTITION OF partitioned_usage_ledger
    FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS usage_ledger_2026_q3 PARTITION OF partitioned_usage_ledger
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');

CREATE TABLE IF NOT EXISTS usage_ledger_2026_q4 PARTITION OF partitioned_usage_ledger
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

-- Dynamic fallback/default partition for bounds out-of-range
CREATE TABLE IF NOT EXISTS usage_ledger_default PARTITION OF partitioned_usage_ledger DEFAULT;
