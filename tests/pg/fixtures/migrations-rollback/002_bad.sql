-- The first statement succeeds, the second fails: the file must leave no trace.
ALTER TABLE mig_demo ADD COLUMN half text;
CREATE TABLE mig_demo (id int);
