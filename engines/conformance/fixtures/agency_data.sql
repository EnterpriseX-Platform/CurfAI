-- Fixture for the policy conformance suite (PostgreSQL, MySQL and MariaDB accept it as is).
-- Three rows for agency A001, two for A002, one for B001, and one with no agency at all.
-- Create it in the target database, and give the SELECT-only account read access.
drop table if exists agency_data;
create table agency_data (
  id int primary key,
  agency_code varchar(10),
  name varchar(50),
  email varchar(100),
  salary int,
  national_id varchar(13),
  amount numeric(10,2),
  created date
);
insert into agency_data values
  (1, 'A001', 'Somchai', 'somchai@a001.go.th', 30000, '1100100000011', 100.50, '2026-01-10'),
  (2, 'A001', 'Malee',   'malee@a001.go.th',   42000, '1100100000022', 200.25, '2026-02-10'),
  (3, 'A001', 'Anan',    'anan@a001.go.th',    28000, '1100100000033',  50.00, '2026-03-10'),
  (4, 'A002', 'Pim',     'pim@a002.go.th',     51000, '1100100000044', 300.00, '2026-01-20'),
  (5, 'A002', 'Nok',     'nok@a002.go.th',     39000, '1100100000055',  10.75, '2026-02-20'),
  (6, 'B001', 'Dao',     'dao@b001.go.th',     60000, '1100100000066', 999.99, '2026-03-20'),
  (7, NULL,   'Orphan',  'orphan@x.go.th',         1, '1100100000077',   1.00, '2026-04-01');
