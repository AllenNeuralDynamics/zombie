"""Quick exploration of the eng-logtools MySQL server - part 2."""
import pymysql

conn = pymysql.connect(
    host="eng-logtools",
    port=3306,
    user="read",
    password="read",
    database="mpe",
    connect_timeout=10,
)
cur = conn.cursor(pymysql.cursors.DictCursor)

print("=== DISTINCT logname values containing 'acquisition' (last_2week) ===")
cur.execute("SELECT DISTINCT logname FROM last_2week WHERE logname LIKE '%acquisition%'")
for r in cur.fetchall():
    print(r)

print("\n=== Sample acquisition_report rows (last_2week) ===")
cur.execute(
    "SELECT * FROM last_2week WHERE logname='acquisition_report' "
    "ORDER BY datetime DESC LIMIT 3"
)
for r in cur.fetchall():
    print(r)
    print("---")

print("\n=== COUNT acquisition_report by table ===")
for tbl in ("last_2week", "last_2month", "last_year", "log_server"):
    cur.execute(f"SELECT COUNT(*) AS n FROM {tbl} WHERE logname='acquisition_report'")
    print(tbl, cur.fetchall())

print("\n=== Date range in last_year (acquisition_report) ===")
cur.execute(
    "SELECT MIN(datetime) AS mn, MAX(datetime) AS mx FROM last_year "
    "WHERE logname='acquisition_report'"
)
print(cur.fetchall())

print("\n=== Date range in log_server (acquisition_report) ===")
cur.execute(
    "SELECT MIN(datetime) AS mn, MAX(datetime) AS mx FROM log_server "
    "WHERE logname='acquisition_report'"
)
print(cur.fetchall())

print("\n=== A few more samples to see message structure variety ===")
cur.execute(
    "SELECT datetime, logname, version, level, location, message "
    "FROM last_year WHERE logname='acquisition_report' "
    "ORDER BY datetime DESC LIMIT 5"
)
for r in cur.fetchall():
    print(r)
    print("---")

conn.close()
