-- 002_cap_change_log.sql
-- Capping trigger for change_log: every 500 inserts, prune entries older than 50,000 sequence IDs
CREATE OR REPLACE FUNCTION cap_change_log_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.seq % 500 = 0) THEN
        DELETE FROM change_log
        WHERE seq < (NEW.seq - 50000);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cap_change_log ON change_log;
CREATE TRIGGER trg_cap_change_log
AFTER INSERT ON change_log
FOR EACH ROW
EXECUTE FUNCTION cap_change_log_trigger();
