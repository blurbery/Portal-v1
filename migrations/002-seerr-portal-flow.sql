-- Apply once to an existing Portal PostgreSQL volume.
-- New installations receive these tables from portal_schema.sql.

create table if not exists seerr_users (like portal_records including all);
create table if not exists seerr_history (like portal_records including all);
