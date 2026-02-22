-- Scenario Modeling: initial schema
-- Run with: psql -f schema.sql (or via migrate script)

CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) NOT NULL,
    department VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenarios (
    scenario_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255),
    description TEXT,
    nl_input TEXT NOT NULL,
    status VARCHAR(50) NOT NULL,
    creator_id UUID NOT NULL REFERENCES users(user_id),
    model_version_hash VARCHAR(64) NOT NULL DEFAULT 'v0',
    base_case_id UUID REFERENCES scenarios(scenario_id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    approved_at TIMESTAMP,
    approved_by UUID REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS scenario_parameters (
    parameter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
    extracted_name VARCHAR(255) NOT NULL,
    mapped_variable_id VARCHAR(255) NOT NULL,
    base_value NUMERIC,
    scenario_value NUMERIC NOT NULL,
    confidence_score DECIMAL(3,2),
    is_override BOOLEAN DEFAULT FALSE,
    override_reason TEXT,
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scenario_outputs (
    output_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
    output_type VARCHAR(50) NOT NULL,
    output_data JSONB NOT NULL,
    narrative_summary TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_trail (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id),
    action_type VARCHAR(50) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(user_id),
    action_details JSONB,
    timestamp TIMESTAMP DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

CREATE TABLE IF NOT EXISTS model_mappings (
    mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_term VARCHAR(255) NOT NULL,
    model_variable_id VARCHAR(255) NOT NULL,
    synonyms TEXT[],
    confidence_weight DECIMAL(3,2) DEFAULT 1.0,
    is_active BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(business_term, model_variable_id)
);

CREATE TABLE IF NOT EXISTS scenario_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    parameter_set JSONB NOT NULL,
    model_version_hash VARCHAR(64),
    created_by UUID REFERENCES users(user_id),
    is_shared BOOLEAN DEFAULT FALSE,
    sharing_scope VARCHAR(50) DEFAULT 'private',
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sharing
CREATE TABLE IF NOT EXISTS scenario_sharing (
    sharing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES scenarios(scenario_id) ON DELETE CASCADE,
    shared_with UUID NOT NULL REFERENCES users(user_id),
    permission VARCHAR(20) NOT NULL DEFAULT 'view', -- view | edit
    shared_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(scenario_id, shared_with)
);

-- Override history (tracks every parameter edit)
CREATE TABLE IF NOT EXISTS parameter_override_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parameter_id UUID NOT NULL REFERENCES scenario_parameters(parameter_id) ON DELETE CASCADE,
    previous_value NUMERIC,
    new_value NUMERIC,
    changed_by UUID REFERENCES users(user_id),
    reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Company context (extracted understanding from uploaded documents)
CREATE TABLE IF NOT EXISTS company_context (
    context_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES users(user_id),
    company_name TEXT,
    industry TEXT,
    context_data JSONB NOT NULL,
    source_document_ids UUID[],
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- User-defined models (replaces hardcoded DEFAULT_MODEL)
CREATE TABLE IF NOT EXISTS user_models (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES users(user_id),
    name TEXT NOT NULL,
    model_definition JSONB NOT NULL,
    source_context_id UUID REFERENCES company_context(context_id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents (for RAG / talk-to-document feature)
CREATE TABLE IF NOT EXISTS documents (
    document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    original_filename VARCHAR(500) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size_bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'processing',
    qdrant_collection VARCHAR(255),
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scenarios_creator ON scenarios(creator_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_status ON scenarios(status);
CREATE INDEX IF NOT EXISTS idx_scenarios_created_at ON scenarios(created_at);
CREATE INDEX IF NOT EXISTS idx_parameters_scenario ON scenario_parameters(scenario_id);
CREATE INDEX IF NOT EXISTS idx_audit_scenario ON audit_trail(scenario_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_trail(timestamp);
CREATE INDEX IF NOT EXISTS idx_mappings_term ON model_mappings(business_term);
CREATE INDEX IF NOT EXISTS idx_mappings_variable ON model_mappings(model_variable_id);

-- Seed default user for local dev / testing only.
-- In production, users should be created via the application or SSO.
-- This seed is safe as ON CONFLICT prevents duplicates.
INSERT INTO users (email, name, role) VALUES ('dev@local', 'Dev User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Seed default mappings so parser output maps to model variables
INSERT INTO model_mappings (business_term, model_variable_id, synonyms) VALUES
  ('raw materials', 'raw_material_cost', ARRAY['raw mats', 'raw_material_cost', 'raw materials increase', 'raw_materials']),
  ('revenue', 'revenue', ARRAY['sales']),
  ('opex', 'opex', ARRAY['sg&a', 'sga', 'marketing', 'operating expense']),
  ('geo_apac', 'units_sold', ARRAY['apac', 'asia pacific']),
  ('Launch or timeline delay', 'units_sold', ARRAY['delay', 'timeline shift'])
ON CONFLICT (business_term, model_variable_id) DO UPDATE SET synonyms = EXCLUDED.synonyms, updated_at = NOW();
