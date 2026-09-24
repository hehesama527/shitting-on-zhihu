import type { Pool, RowDataPacket } from "mysql2/promise";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  zhihu_user_name VARCHAR(255) NULL,
  writer_prompt_version_id INT NULL,
  risk_domain VARCHAR(128) NOT NULL DEFAULT 'default',
  status VARCHAR(64) NOT NULL DEFAULT 'active',
  status_reason LONGTEXT NULL,
  profile_dir VARCHAR(512) NULL,
  cooldown_until DATETIME NULL,
  last_risk_at DATETIME NULL,
  last_login_check_at DATETIME NULL,
  last_publish_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topic_candidates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NULL,
  question_url VARCHAR(1024) NOT NULL,
  question_title VARCHAR(512) NOT NULL,
  source_type VARCHAR(64) NOT NULL,
  source_metadata_text LONGTEXT NULL,
  priority VARCHAR(16) NULL,
  fit_score INT NULL,
  question_type VARCHAR(64) NULL,
  persona_mode VARCHAR(64) NULL,
  must_avoid_text LONGTEXT NULL,
  risk_notes_text LONGTEXT NULL,
  validity_status VARCHAR(64) NOT NULL DEFAULT 'unchecked',
  validity_reason LONGTEXT NULL,
  checked_at DATETIME NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'new',
  duplication_fingerprint_text LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_topic_candidates_account_status (account_id, status, validity_status, created_at)
);

CREATE TABLE IF NOT EXISTS topic_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  topic_candidate_id INT NOT NULL,
  summary_text LONGTEXT NOT NULL,
  output_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_topic_cards_candidate FOREIGN KEY (topic_candidate_id) REFERENCES topic_candidates(id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  topic_card_id INT NOT NULL,
  draft_type VARCHAR(64) NOT NULL,
  content LONGTEXT NOT NULL,
  summary_text LONGTEXT NULL,
  output_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_drafts_topic_card FOREIGN KEY (topic_card_id) REFERENCES topic_cards(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_id INT NOT NULL,
  review_status VARCHAR(64) NOT NULL,
  hard_gate_json LONGTEXT NOT NULL,
  editorial_review_json LONGTEXT NOT NULL,
  publish_review_json LONGTEXT NOT NULL,
  topic_duplication_json LONGTEXT NOT NULL,
  content_duplication_json LONGTEXT NOT NULL,
  approved_content LONGTEXT NULL,
  review_summary LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reviews_draft FOREIGN KEY (draft_id) REFERENCES drafts(id)
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  topic_card_id INT NULL,
  review_id INT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'queued',
  title VARCHAR(512) NULL,
  scheduled_at DATETIME NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  final_url VARCHAR(1024) NULL,
  retry_count INT NOT NULL DEFAULT 0,
  failure_reason LONGTEXT NULL,
  prompt_version_snapshot_json LONGTEXT NULL,
  soul_version INT NULL,
  soul_markdown_snapshot LONGTEXT NULL,
  current_stage VARCHAR(64) NULL,
  resume_anchor_json LONGTEXT NULL,
  last_trace_id VARCHAR(128) NULL,
  last_error_type VARCHAR(128) NULL,
  image_asset_id VARCHAR(36) NULL,
  lease_owner VARCHAR(128) NULL,
  lease_until DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_publish_jobs_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_publish_jobs_topic_card FOREIGN KEY (topic_card_id) REFERENCES topic_cards(id),
  CONSTRAINT fk_publish_jobs_review FOREIGN KEY (review_id) REFERENCES reviews(id)
);

CREATE TABLE IF NOT EXISTS answered_topics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NULL,
  question_url_hash CHAR(64) NOT NULL,
  question_url VARCHAR(1024) NOT NULL,
  question_title VARCHAR(512) NOT NULL,
  topic_candidate_id INT NULL,
  topic_card_id INT NULL,
  review_id INT NULL,
  publish_job_id INT NULL,
  answer_url VARCHAR(1024) NULL,
  answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_answered_topics_account_question (account_id, question_url_hash),
  INDEX idx_answered_topics_account_answered (account_id, answered_at),
  INDEX idx_answered_topics_publish_job (publish_job_id),
  CONSTRAINT fk_answered_topics_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_answered_topics_candidate FOREIGN KEY (topic_candidate_id) REFERENCES topic_candidates(id),
  CONSTRAINT fk_answered_topics_topic_card FOREIGN KEY (topic_card_id) REFERENCES topic_cards(id),
  CONSTRAINT fk_answered_topics_review FOREIGN KEY (review_id) REFERENCES reviews(id),
  CONSTRAINT fk_answered_topics_job FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id)
);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  publish_job_id INT NOT NULL,
  attempt_no INT NOT NULL,
  status VARCHAR(64) NOT NULL,
  current_url VARCHAR(1024) NULL,
  failure_type VARCHAR(128) NULL,
  failure_reason LONGTEXT NULL,
  attempt_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_publish_attempts_job FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  publish_attempt_id INT NULL,
  artifact_type VARCHAR(64) NOT NULL,
  file_path VARCHAR(1024) NOT NULL,
  meta_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_artifacts_attempt FOREIGN KEY (publish_attempt_id) REFERENCES publish_attempts(id)
);

CREATE TABLE IF NOT EXISTS tool_traces (
  id INT AUTO_INCREMENT PRIMARY KEY,
  publish_job_id INT NULL,
  publish_attempt_id INT NULL,
  trace_id VARCHAR(128) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  tool_name VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  input_json LONGTEXT NOT NULL,
  result_json LONGTEXT NULL,
  artifact_path VARCHAR(1024) NULL,
  duration_ms INT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tool_traces_job (publish_job_id, created_at),
  INDEX idx_tool_traces_trace (trace_id),
  CONSTRAINT fk_tool_traces_job FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id),
  CONSTRAINT fk_tool_traces_attempt FOREIGN KEY (publish_attempt_id) REFERENCES publish_attempts(id)
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  publish_job_id INT NULL,
  publish_attempt_id INT NULL,
  skill_name VARCHAR(64) NOT NULL,
  agent_name VARCHAR(128) NOT NULL,
  stage VARCHAR(64) NULL,
  trace_id VARCHAR(128) NULL,
  input_json LONGTEXT NOT NULL,
  output_json LONGTEXT NULL,
  duration_ms INT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_skill_runs_job (publish_job_id, created_at),
  INDEX idx_skill_runs_trace (trace_id),
  CONSTRAINT fk_skill_runs_job FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id),
  CONSTRAINT fk_skill_runs_attempt FOREIGN KEY (publish_attempt_id) REFERENCES publish_attempts(id)
);

CREATE TABLE IF NOT EXISTS daily_publish_schedule (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NULL,
  schedule_date DATE NOT NULL,
  scheduled_at DATETIME NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'pending',
  publish_job_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_schedule_slot_account (account_id, schedule_date, scheduled_at),
  INDEX idx_schedule_account_date (account_id, schedule_date, scheduled_at),
  CONSTRAINT fk_schedule_job FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id),
  CONSTRAINT fk_schedule_account FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS prompt_sets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prompt_set_id INT NOT NULL,
  version INT NOT NULL,
  label VARCHAR(255) NOT NULL,
  content LONGTEXT NOT NULL,
  notes LONGTEXT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'draft',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_prompt_set_version (prompt_set_id, version),
  CONSTRAINT fk_prompt_versions_set FOREIGN KEY (prompt_set_id) REFERENCES prompt_sets(id)
);

CREATE TABLE IF NOT EXISTS prompt_activations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prompt_set_id INT NOT NULL,
  prompt_version_id INT NOT NULL,
  activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prompt_activations_set FOREIGN KEY (prompt_set_id) REFERENCES prompt_sets(id),
  CONSTRAINT fk_prompt_activations_version FOREIGN KEY (prompt_version_id) REFERENCES prompt_versions(id)
);

CREATE TABLE IF NOT EXISTS prompt_test_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prompt_version_id INT NOT NULL,
  input_json LONGTEXT NOT NULL,
  output_json LONGTEXT NULL,
  error_text LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prompt_test_runs_version FOREIGN KEY (prompt_version_id) REFERENCES prompt_versions(id)
);

CREATE TABLE IF NOT EXISTS image_assets (
  id VARCHAR(36) PRIMARY KEY,
  asset_type VARCHAR(32) NOT NULL DEFAULT 'other',
  source_type VARCHAR(32) NOT NULL DEFAULT 'local_import',
  file_name VARCHAR(255) NOT NULL,
  source_path LONGTEXT NULL,
  storage_path LONGTEXT NOT NULL,
  thumbnail_path LONGTEXT NULL,
  file_hash CHAR(64) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  file_size BIGINT NOT NULL,
  width INT NULL,
  height INT NULL,
  aspect_ratio VARCHAR(32) NOT NULL DEFAULT 'square',
  platform_scope VARCHAR(32) NOT NULL DEFAULT 'unknown',
  usage_scope VARCHAR(64) NOT NULL DEFAULT 'general',
  has_text TINYINT(1) NOT NULL DEFAULT 0,
  ocr_text LONGTEXT NULL,
  anchor_keyword VARCHAR(128) NULL,
  caption_short LONGTEXT NULL,
  caption_long LONGTEXT NULL,
  auto_caption LONGTEXT NULL,
  manual_caption LONGTEXT NULL,
  entity_tags JSON NULL,
  topic_tags JSON NULL,
  emotion_tags JSON NULL,
  scene_tags JSON NULL,
  style_tags JSON NULL,
  risk_level VARCHAR(32) NOT NULL DEFAULT 'unknown',
  risk_notes LONGTEXT NULL,
  copyright_source LONGTEXT NULL,
  analysis_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  analysis_error LONGTEXT NULL,
  analysis_payload_json LONGTEXT NULL,
  manual_override_fields_json LONGTEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_review',
  use_count INT NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_image_assets_file_hash (file_hash),
  INDEX idx_image_assets_status_platform_type (status, platform_scope, asset_type),
  INDEX idx_image_assets_created (created_at),
  INDEX idx_image_assets_last_used (last_used_at)
);

CREATE TABLE IF NOT EXISTS image_import_jobs (
  id VARCHAR(36) PRIMARY KEY,
  source_type VARCHAR(32) NOT NULL,
  source_path LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  total_count INT NOT NULL DEFAULT 0,
  imported_count INT NOT NULL DEFAULT 0,
  duplicated_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  INDEX idx_image_import_jobs_status_created (status, created_at)
);

CREATE TABLE IF NOT EXISTS image_asset_usage_records (
  id VARCHAR(36) PRIMARY KEY,
  asset_id VARCHAR(36) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  account_id VARCHAR(64) NULL,
  task_id VARCHAR(64) NULL,
  content_id VARCHAR(64) NULL,
  usage_type VARCHAR(64) NOT NULL DEFAULT 'preview',
  selected_by VARCHAR(32) NOT NULL DEFAULT 'manual',
  note LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_image_usage_asset (asset_id),
  INDEX idx_image_usage_platform_task (platform, task_id),
  CONSTRAINT fk_image_asset_usage_asset FOREIGN KEY (asset_id) REFERENCES image_assets(id)
);

CREATE TABLE IF NOT EXISTS video_topic_batches (
  id VARCHAR(36) PRIMARY KEY,
  source VARCHAR(32) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'pending_feedback',
  target_platform VARCHAR(32) NOT NULL DEFAULT 'agnostic',
  target_count INT NOT NULL DEFAULT 10,
  generated_count INT NOT NULL DEFAULT 0,
  selected_count INT NOT NULL DEFAULT 0,
  summary LONGTEXT NULL,
  input_json LONGTEXT NULL,
  output_json LONGTEXT NULL,
  error_message LONGTEXT NULL,
  notified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_topic_batches_status_created (status, created_at),
  INDEX idx_video_topic_batches_source_created (source, created_at)
);

CREATE TABLE IF NOT EXISTS video_topic_candidates (
  id VARCHAR(36) PRIMARY KEY,
  batch_id VARCHAR(36) NOT NULL,
  source VARCHAR(32) NOT NULL,
  target_platform VARCHAR(32) NOT NULL DEFAULT 'agnostic',
  title VARCHAR(160) NOT NULL,
  brief LONGTEXT NOT NULL,
  angle LONGTEXT NOT NULL,
  video_format VARCHAR(64) NOT NULL,
  target_audience LONGTEXT NOT NULL,
  why_this LONGTEXT NOT NULL,
  estimated_duration_sec INT NULL,
  score INT NOT NULL DEFAULT 0,
  topic_fit_score INT NULL,
  production_score INT NULL,
  score_breakdown_json LONGTEXT NULL,
  risk_notes_json LONGTEXT NULL,
  source_refs_json LONGTEXT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'pending_feedback',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_candidates_batch (batch_id),
  INDEX idx_video_candidates_status_created (status, created_at),
  CONSTRAINT fk_video_candidates_batch FOREIGN KEY (batch_id) REFERENCES video_topic_batches(id)
);

CREATE TABLE IF NOT EXISTS video_topic_feedback (
  id VARCHAR(36) PRIMARY KEY,
  candidate_id VARCHAR(36) NOT NULL,
  batch_id VARCHAR(36) NOT NULL,
  decision VARCHAR(32) NOT NULL,
  reason LONGTEXT NULL,
  suggestion LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_video_topic_feedback_candidate (candidate_id, created_at),
  CONSTRAINT fk_video_feedback_candidate FOREIGN KEY (candidate_id) REFERENCES video_topic_candidates(id),
  CONSTRAINT fk_video_feedback_batch FOREIGN KEY (batch_id) REFERENCES video_topic_batches(id)
);

CREATE TABLE IF NOT EXISTS video_projects (
  id VARCHAR(36) PRIMARY KEY,
  topic_candidate_id VARCHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'topic_selected',
  target_platform VARCHAR(32) NOT NULL DEFAULT 'agnostic',
  aspect_ratio VARCHAR(16) NOT NULL DEFAULT '16:9',
  target_duration_sec INT NULL,
  script_pack_json LONGTEXT NULL,
  visual_render_plan_json LONGTEXT NULL,
  script_confirmed_at DATETIME NULL,
  visual_render_plan_confirmed_at DATETIME NULL,
  final_video_asset_id VARCHAR(36) NULL,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_projects_status_updated (status, updated_at),
  INDEX idx_video_projects_topic (topic_candidate_id),
  CONSTRAINT fk_video_projects_topic FOREIGN KEY (topic_candidate_id) REFERENCES video_topic_candidates(id)
);

CREATE TABLE IF NOT EXISTS video_case_intents (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'requested',
  data_source VARCHAR(64) NOT NULL DEFAULT 'cryptopathx_mongo',
  symbol VARCHAR(32) NOT NULL,
  kline_interval VARCHAR(16) NOT NULL,
  collection_name VARCHAR(128) NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  strategy_name VARCHAR(64) NOT NULL,
  strategy_params_json LONGTEXT NOT NULL,
  assumptions_json LONGTEXT NOT NULL,
  request_json LONGTEXT NOT NULL,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_case_intents_project_created (project_id, created_at),
  INDEX idx_video_case_intents_status_updated (status, updated_at),
  CONSTRAINT fk_video_case_intents_project FOREIGN KEY (project_id) REFERENCES video_projects(id)
);

CREATE TABLE IF NOT EXISTS video_verified_case_packs (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  case_intent_id VARCHAR(36) NOT NULL,
  case_id VARCHAR(128) NOT NULL,
  status VARCHAR(64) NOT NULL,
  data_source_json LONGTEXT NOT NULL,
  strategy_json LONGTEXT NOT NULL,
  metrics_json LONGTEXT NOT NULL,
  review_json LONGTEXT NOT NULL,
  chart_data_json LONGTEXT NOT NULL,
  pack_json LONGTEXT NOT NULL,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_case_packs_project_created (project_id, created_at),
  INDEX idx_video_case_packs_case_intent (case_intent_id),
  INDEX idx_video_case_packs_status_created (status, created_at),
  CONSTRAINT fk_video_case_packs_project FOREIGN KEY (project_id) REFERENCES video_projects(id),
  CONSTRAINT fk_video_case_packs_intent FOREIGN KEY (case_intent_id) REFERENCES video_case_intents(id)
);

CREATE TABLE IF NOT EXISTS video_project_segments (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  segment_key VARCHAR(64) NOT NULL,
  segment_order INT NOT NULL,
  title VARCHAR(160) NOT NULL,
  voiceover LONGTEXT NOT NULL,
  subtitle LONGTEXT NOT NULL,
  image_prompt LONGTEXT NOT NULL,
  visual_intent LONGTEXT NULL,
  visual_builder VARCHAR(32) NULL,
  duration_sec INT NOT NULL DEFAULT 10,
  chart_spec_json LONGTEXT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'planned',
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_video_segment_key (project_id, segment_key),
  INDEX idx_video_segments_project_order (project_id, segment_order),
  INDEX idx_video_segments_status (status, updated_at),
  CONSTRAINT fk_video_segments_project FOREIGN KEY (project_id) REFERENCES video_projects(id)
);

CREATE TABLE IF NOT EXISTS video_assets (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  segment_id VARCHAR(36) NULL,
  asset_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  builder VARCHAR(32) NULL,
  file_path VARCHAR(1024) NULL,
  public_url VARCHAR(1024) NULL,
  mime_type VARCHAR(128) NULL,
  width INT NULL,
  height INT NULL,
  duration_ms INT NULL,
  attempt_no INT NOT NULL DEFAULT 1,
  metadata_json LONGTEXT NULL,
  error_message LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_assets_project_type_status (project_id, asset_type, status),
  INDEX idx_video_assets_segment_type_status (segment_id, asset_type, status),
  CONSTRAINT fk_video_assets_project FOREIGN KEY (project_id) REFERENCES video_projects(id),
  CONSTRAINT fk_video_assets_segment FOREIGN KEY (segment_id) REFERENCES video_project_segments(id)
);

CREATE TABLE IF NOT EXISTS video_feedback_documents (
  id VARCHAR(36) PRIMARY KEY,
  scope VARCHAR(32) NOT NULL DEFAULT 'global',
  project_id VARCHAR(36) NULL,
  markdown LONGTEXT NOT NULL,
  summary_json LONGTEXT NULL,
  file_path VARCHAR(1024) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_video_feedback_documents_scope_created (scope, created_at),
  CONSTRAINT fk_video_feedback_documents_project FOREIGN KEY (project_id) REFERENCES video_projects(id)
);

CREATE TABLE IF NOT EXISTS video_project_events (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  from_status VARCHAR(64) NULL,
  to_status VARCHAR(64) NULL,
  message LONGTEXT NULL,
  payload_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_video_events_project_created (project_id, created_at),
  CONSTRAINT fk_video_events_project FOREIGN KEY (project_id) REFERENCES video_projects(id)
);

CREATE TABLE IF NOT EXISTS ops_incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL,
  source VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  service_name VARCHAR(64) NOT NULL,
  account_id INT NULL,
  job_id INT NULL,
  failure_type VARCHAR(128) NULL,
  title VARCHAR(255) NOT NULL,
  diagnosis_summary LONGTEXT NULL,
  root_cause LONGTEXT NULL,
  suggested_action LONGTEXT NULL,
  raw_error_excerpt LONGTEXT NULL,
  evidence_json LONGTEXT NULL,
  notification_delivery VARCHAR(32) NULL,
  notification_message LONGTEXT NULL,
  notified_at DATETIME NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ops_incidents_fingerprint (fingerprint),
  INDEX idx_ops_incidents_status_severity (status, severity, updated_at),
  INDEX idx_ops_incidents_service_status (service_name, status, updated_at),
  INDEX idx_ops_incidents_job_status (job_id, status, updated_at)
);

CREATE TABLE IF NOT EXISTS zhihu_scraped_content (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_account VARCHAR(255) NOT NULL,
  content_type VARCHAR(32) NOT NULL,
  content_id VARCHAR(128) NOT NULL,
  question_title VARCHAR(512) NULL,
  question_url VARCHAR(1024) NULL,
  content_text LONGTEXT NULL,
  content_html LONGTEXT NULL,
  vote_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  scraped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  content_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  rejected_reason VARCHAR(255) NULL,
  UNIQUE KEY uniq_zhihu_scraped_content_source (source_account, content_type, content_id),
  INDEX idx_zhihu_scraped_content_query (source_account, status, scraped_at)
);
`;

type ColumnMigration = {
  table: string;
  column: string;
  ddl: string;
};

const columnMigrations: ColumnMigration[] = [
  {
    table: "accounts",
    column: "risk_domain",
    ddl: "ALTER TABLE accounts ADD COLUMN risk_domain VARCHAR(128) NOT NULL DEFAULT 'default' AFTER writer_prompt_version_id"
  },
  {
    table: "accounts",
    column: "status_reason",
    ddl: "ALTER TABLE accounts ADD COLUMN status_reason LONGTEXT NULL AFTER status"
  },
  {
    table: "accounts",
    column: "cooldown_until",
    ddl: "ALTER TABLE accounts ADD COLUMN cooldown_until DATETIME NULL AFTER profile_dir"
  },
  {
    table: "accounts",
    column: "last_risk_at",
    ddl: "ALTER TABLE accounts ADD COLUMN last_risk_at DATETIME NULL AFTER cooldown_until"
  },
  {
    table: "accounts",
    column: "writer_prompt_version_id",
    ddl: "ALTER TABLE accounts ADD COLUMN writer_prompt_version_id INT NULL AFTER zhihu_user_name"
  },
  {
    table: "topic_candidates",
    column: "account_id",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN account_id INT NULL AFTER id"
  },
  {
    table: "topic_candidates",
    column: "priority",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN priority VARCHAR(16) NULL AFTER source_metadata_text"
  },
  {
    table: "topic_candidates",
    column: "fit_score",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN fit_score INT NULL AFTER priority"
  },
  {
    table: "topic_candidates",
    column: "question_type",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN question_type VARCHAR(64) NULL AFTER fit_score"
  },
  {
    table: "topic_candidates",
    column: "persona_mode",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN persona_mode VARCHAR(64) NULL AFTER question_type"
  },
  {
    table: "topic_candidates",
    column: "must_avoid_text",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN must_avoid_text LONGTEXT NULL AFTER persona_mode"
  },
  {
    table: "topic_candidates",
    column: "risk_notes_text",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN risk_notes_text LONGTEXT NULL AFTER must_avoid_text"
  },
  {
    table: "topic_candidates",
    column: "validity_status",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN validity_status VARCHAR(64) NOT NULL DEFAULT 'unchecked' AFTER risk_notes_text"
  },
  {
    table: "topic_candidates",
    column: "validity_reason",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN validity_reason LONGTEXT NULL AFTER validity_status"
  },
  {
    table: "topic_candidates",
    column: "checked_at",
    ddl: "ALTER TABLE topic_candidates ADD COLUMN checked_at DATETIME NULL AFTER validity_reason"
  },
  {
    table: "publish_jobs",
    column: "prompt_version_snapshot_json",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN prompt_version_snapshot_json LONGTEXT NULL AFTER failure_reason"
  },
  {
    table: "publish_jobs",
    column: "current_stage",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN current_stage VARCHAR(64) NULL AFTER prompt_version_snapshot_json"
  },
  {
    table: "publish_jobs",
    column: "soul_version",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN soul_version INT NULL AFTER prompt_version_snapshot_json"
  },
  {
    table: "publish_jobs",
    column: "soul_markdown_snapshot",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN soul_markdown_snapshot LONGTEXT NULL AFTER soul_version"
  },
  {
    table: "publish_jobs",
    column: "resume_anchor_json",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN resume_anchor_json LONGTEXT NULL AFTER current_stage"
  },
  {
    table: "publish_jobs",
    column: "last_trace_id",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN last_trace_id VARCHAR(128) NULL AFTER resume_anchor_json"
  },
  {
    table: "publish_jobs",
    column: "last_error_type",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN last_error_type VARCHAR(128) NULL AFTER last_trace_id"
  },
  {
    table: "publish_jobs",
    column: "image_asset_id",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN image_asset_id VARCHAR(36) NULL AFTER last_error_type"
  },
  {
    table: "publish_jobs",
    column: "lease_owner",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN lease_owner VARCHAR(128) NULL AFTER image_asset_id"
  },
  {
    table: "publish_jobs",
    column: "lease_until",
    ddl: "ALTER TABLE publish_jobs ADD COLUMN lease_until DATETIME NULL AFTER lease_owner"
  },
  {
    table: "daily_publish_schedule",
    column: "account_id",
    ddl: "ALTER TABLE daily_publish_schedule ADD COLUMN account_id INT NULL AFTER id"
  },
  {
    table: "image_assets",
    column: "anchor_keyword",
    ddl: "ALTER TABLE image_assets ADD COLUMN anchor_keyword VARCHAR(128) NULL AFTER ocr_text"
  },
  {
    table: "image_assets",
    column: "caption_short",
    ddl: "ALTER TABLE image_assets ADD COLUMN caption_short LONGTEXT NULL AFTER anchor_keyword"
  },
  {
    table: "image_assets",
    column: "caption_long",
    ddl: "ALTER TABLE image_assets ADD COLUMN caption_long LONGTEXT NULL AFTER caption_short"
  },
  {
    table: "image_assets",
    column: "entity_tags",
    ddl: "ALTER TABLE image_assets ADD COLUMN entity_tags JSON NULL AFTER manual_caption"
  },
  {
    table: "zhihu_scraped_content",
    column: "rejected_reason",
    ddl: "ALTER TABLE zhihu_scraped_content ADD COLUMN rejected_reason VARCHAR(255) NULL AFTER status"
  }
];

const rawMigrations = [
  "UPDATE accounts SET risk_domain = 'default' WHERE risk_domain IS NULL OR TRIM(risk_domain) = ''",
  "ALTER TABLE publish_jobs MODIFY COLUMN topic_card_id INT NULL",
  "ALTER TABLE publish_jobs MODIFY COLUMN review_id INT NULL",
  "ALTER TABLE publish_jobs MODIFY COLUMN title VARCHAR(512) NULL",
  "ALTER TABLE publish_jobs MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'queued'",
  `UPDATE image_assets
   SET caption_short = auto_caption
   WHERE (caption_short IS NULL OR TRIM(caption_short) = '')
     AND auto_caption IS NOT NULL
     AND TRIM(auto_caption) <> ''`
];

type IndexMigration = {
  table: string;
  index: string;
  ddl: string;
};

const dropIndexMigrations: IndexMigration[] = [
  {
    table: "daily_publish_schedule",
    index: "uniq_schedule_slot",
    ddl: "ALTER TABLE daily_publish_schedule DROP INDEX uniq_schedule_slot"
  },
  {
    table: "answered_topics",
    index: "uniq_answered_topics_question_hash",
    ddl: "ALTER TABLE answered_topics DROP INDEX uniq_answered_topics_question_hash"
  }
];

const addIndexMigrations: IndexMigration[] = [
  {
    table: "publish_jobs",
    index: "idx_publish_jobs_lease",
    ddl: "ALTER TABLE publish_jobs ADD INDEX idx_publish_jobs_lease (status, lease_until)"
  },
  {
    table: "topic_candidates",
    index: "idx_topic_candidates_account_status",
    ddl: "ALTER TABLE topic_candidates ADD INDEX idx_topic_candidates_account_status (account_id, status, validity_status, created_at)"
  },
  {
    table: "daily_publish_schedule",
    index: "uniq_schedule_slot_account",
    ddl: "ALTER TABLE daily_publish_schedule ADD UNIQUE KEY uniq_schedule_slot_account (account_id, schedule_date, scheduled_at)"
  },
  {
    table: "daily_publish_schedule",
    index: "idx_schedule_account_date",
    ddl: "ALTER TABLE daily_publish_schedule ADD INDEX idx_schedule_account_date (account_id, schedule_date, scheduled_at)"
  },
  {
    table: "publish_jobs",
    index: "idx_publish_jobs_image_asset",
    ddl: "ALTER TABLE publish_jobs ADD INDEX idx_publish_jobs_image_asset (image_asset_id)"
  },
  {
    table: "answered_topics",
    index: "uniq_answered_topics_account_question",
    ddl: "ALTER TABLE answered_topics ADD UNIQUE KEY uniq_answered_topics_account_question (account_id, question_url_hash)"
  }
];

export async function applySchemaMigrations(pool: Pool) {
  await pool.query(schemaSql);

  for (const migration of columnMigrations) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [migration.table, migration.column]
    );

    if (Number(rows[0]?.count ?? 0) === 0) {
      await pool.query(migration.ddl);
    }
  }

  for (const ddl of rawMigrations) {
    await pool.query(ddl);
  }

  for (const migration of dropIndexMigrations) {
    if (await hasIndex(pool, migration.table, migration.index)) {
      await pool.query(migration.ddl);
    }
  }

  for (const migration of addIndexMigrations) {
    if (!(await hasIndex(pool, migration.table, migration.index))) {
      await pool.query(migration.ddl);
    }
  }

  await backfillAnsweredTopics(pool);
}

async function hasIndex(pool: Pool, table: string, index: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [table, index]
  );

  return Number(rows[0]?.count ?? 0) > 0;
}

async function backfillAnsweredTopics(pool: Pool) {
  await pool.query(
    `INSERT INTO answered_topics (
       account_id,
       question_url_hash,
       question_url,
       question_title,
       topic_candidate_id,
       topic_card_id,
       review_id,
       publish_job_id,
       answer_url,
       answered_at
     )
     SELECT
       pj.account_id,
       LOWER(SHA2(tc.question_url, 256)),
       tc.question_url,
       tc.question_title,
       tc.id,
       tcard.id,
       pj.review_id,
       pj.id,
       pj.final_url,
       COALESCE(pj.finished_at, pj.updated_at, pj.created_at)
     FROM publish_jobs pj
     JOIN topic_cards tcard ON tcard.id = pj.topic_card_id
     JOIN topic_candidates tc ON tc.id = tcard.topic_candidate_id
     WHERE pj.status = 'published'
       AND tc.question_url IS NOT NULL
       AND tc.question_url <> ''
     ON DUPLICATE KEY UPDATE
       account_id = COALESCE(VALUES(account_id), answered_topics.account_id),
       question_url = VALUES(question_url),
       question_title = VALUES(question_title),
       topic_candidate_id = COALESCE(VALUES(topic_candidate_id), answered_topics.topic_candidate_id),
       topic_card_id = COALESCE(VALUES(topic_card_id), answered_topics.topic_card_id),
       review_id = COALESCE(VALUES(review_id), answered_topics.review_id),
       publish_job_id = COALESCE(VALUES(publish_job_id), answered_topics.publish_job_id),
       answer_url = COALESCE(VALUES(answer_url), answered_topics.answer_url),
       answered_at = GREATEST(answered_topics.answered_at, VALUES(answered_at))`
  );
}
