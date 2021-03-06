module.exports = {
  get,
  getAll
}

function get (schema, version, uninstall, migrations) {
  migrations = migrations || getAll(schema)

  for (let m = 0; m < migrations.length; m++) {
    const migration = migrations[m]

    const targetVersion = uninstall ? 'previous' : 'version'
    const sourceVersion = uninstall ? 'version' : 'previous'

    const targetCommands = uninstall ? 'uninstall' : 'install'

    if (migration[sourceVersion] === version) {
      const commands = migration[targetCommands].concat()

      commands.push(`UPDATE ${schema}.version SET version = '${migration[targetVersion]}';`)

      return {
        version: migration[targetVersion],
        commands
      }
    }
  }
}

function getAll (schema) {
  return [
    {
      version: '0.1.0',
      previous: '0.0.1',
      install: [
        `ALTER TABLE ${schema}.job ADD singletonOn timestamp without time zone`,
        `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
        // one time truncate because previous schema was inserting each version
        `TRUNCATE TABLE ${schema}.version`,
        `INSERT INTO ${schema}.version(version) values('0.0.1')`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
        `ALTER TABLE ${schema}.job DROP COLUMN singletonOn`
      ]
    },
    {
      version: '2',
      previous: '0.1.0',
      install: [
        `CREATE TYPE ${schema}.job_state AS ENUM ('created','retry','active','complete','expired','cancelled')`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
        `ALTER TABLE ${schema}.job ADD singletonKey text`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete' AND singletonOn IS NULL`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        // migrate data to use retry state
        `UPDATE ${schema}.job SET state = 'retry' WHERE state = 'expired' AND retryCount < retryLimit`,
        // expired jobs weren't being archived in prev schema
        `UPDATE ${schema}.job SET completedOn = now() WHERE state = 'expired' and retryLimit = retryCount`,
        // just using good ole fashioned completedOn
        `ALTER TABLE ${schema}.job DROP COLUMN expiredOn`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ADD expiredOn timestamp without time zone`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `ALTER TABLE ${schema}.job DROP COLUMN singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text`,
        `DROP TYPE ${schema}.job_state`,
        // restoring prev unique constraint
        `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
        // roll retry state back to expired
        `UPDATE ${schema}.job SET state = 'expired' where state = 'retry'`
      ]
    },
    {
      version: '3',
      previous: '2',
      install: [
        `ALTER TYPE ${schema}.job_state ADD VALUE IF NOT EXISTS 'failed' AFTER 'cancelled'`
      ],
      uninstall: [
        // There is currently no simple syntax like ALTER TYPE my_enum REMOVE VALUE my_value
        // Also, we'd have to remove the data during uninstall and who would enjoy that?
        // The migration committee decided to allow a leaky migration here since rollbacks are edge cases
        //   and IF NOT EXISTS will not throw on re-application
      ]
    },
    {
      version: '4',
      previous: '3',
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN priority integer not null default(0)`,
        `ALTER TABLE ${schema}.job ALTER COLUMN createdOn SET DATA TYPE timestamptz`,
        `ALTER TABLE ${schema}.job ALTER COLUMN startedOn SET DATA TYPE timestamptz`,
        `ALTER TABLE ${schema}.job ALTER COLUMN completedOn SET DATA TYPE timestamptz`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP COLUMN priority`,
        `ALTER TABLE ${schema}.job ALTER COLUMN createdOn SET DATA TYPE timestamp`,
        `ALTER TABLE ${schema}.job ALTER COLUMN startedOn SET DATA TYPE timestamp`,
        `ALTER TABLE ${schema}.job ALTER COLUMN completedOn SET DATA TYPE timestamp`
      ]
    },
    {
      version: '5',
      previous: '4',
      install: [
        `ALTER TABLE ${schema}.job ALTER COLUMN startIn SET DEFAULT (interval '0')`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT ('created')`,
        `UPDATE ${schema}.job SET name = left(name, -9) || '__state__expired' WHERE name LIKE '%__expired'`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN startIn DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `UPDATE ${schema}.job SET name = left(name, -16) || '__expired' WHERE name LIKE '%__state__expired'`
      ]
    },
    {
      version: '6',
      previous: '5',
      install: [
        `CREATE INDEX job_fetch ON ${schema}.job (priority desc, createdOn, id) WHERE state < 'active'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_fetch`
      ]
    },
    {
      version: '7',
      previous: '6',
      install: [
        `CREATE TABLE IF NOT EXISTS ${schema}.archive (LIKE ${schema}.job)`,
        `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`
      ],
      uninstall: [
        `DROP TABLE ${schema}.archive`
      ]
    },
    {
      version: '8',
      previous: '7',
      install: [
        'CREATE EXTENSION IF NOT EXISTS pgcrypto',
        `ALTER TABLE ${schema}.job ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
        `ALTER TABLE ${schema}.job ADD retryDelay integer not null DEFAULT (0)`,
        `ALTER TABLE ${schema}.job ADD retryBackoff boolean not null DEFAULT false`,
        `ALTER TABLE ${schema}.job ADD startAfter timestamp with time zone not null default now()`,
        `UPDATE ${schema}.job SET startAfter = createdOn + startIn`,
        `ALTER TABLE ${schema}.job DROP COLUMN startIn`,
        `UPDATE ${schema}.job SET expireIn = interval '15 minutes' WHERE expireIn IS NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn SET NOT NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn SET DEFAULT interval '15 minutes'`,
        // archive table schema changes
        `ALTER TABLE ${schema}.archive ADD retryDelay integer not null DEFAULT (0)`,
        `ALTER TABLE ${schema}.archive ADD retryBackoff boolean not null DEFAULT false`,
        `ALTER TABLE ${schema}.archive ADD startAfter timestamp with time zone`,
        `UPDATE ${schema}.archive SET startAfter = createdOn + startIn`,
        `ALTER TABLE ${schema}.archive DROP COLUMN startIn`,
        // rename complete to completed for state enum - can't use ALTER TYPE :(
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'expired', 'cancelled', 'failed')`,
        `UPDATE ${schema}.job SET state = 'completed' WHERE state = 'complete'`,
        `UPDATE ${schema}.archive SET state = 'completed' WHERE state = 'complete'`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL`,
        // add new job name index
        `CREATE INDEX job_name ON ${schema}.job (name) WHERE state < 'active'`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN id DROP DEFAULT`,
        // won't know if we should drop pgcrypto extension so it stays
        `ALTER TABLE ${schema}.job DROP COLUMN retryDelay`,
        `ALTER TABLE ${schema}.job DROP COLUMN retryBackoff`,
        `ALTER TABLE ${schema}.job DROP COLUMN startAfter`,
        `ALTER TABLE ${schema}.job ADD COLUMN startIn interval not null default(interval '0')`,
        // leaving migrated default data for expireIn
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn DROP NOT NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn DROP DEFAULT`,
        // archive table restore
        `ALTER TABLE ${schema}.archive DROP COLUMN retryDelay`,
        `ALTER TABLE ${schema}.archive DROP COLUMN retryBackoff`,
        `ALTER TABLE ${schema}.archive DROP COLUMN startAfter`,
        `ALTER TABLE ${schema}.archive ADD COLUMN startIn interval`,
        // drop new job name index
        `DROP INDEX ${schema}.job_name`,
        // roll back to old enum def
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created', 'retry', 'active', 'complete', 'expired', 'cancelled', 'failed')`,
        `UPDATE ${schema}.job SET state = 'completed' WHERE state = 'complete'`,
        `UPDATE ${schema}.archive SET state = 'complete' WHERE state = 'completed'`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete' AND singletonOn IS NULL`
      ]
    },
    {
      version: '9',
      previous: '8',
      install: [
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_name`,
        `CREATE INDEX job_name ON ${schema}.job (name text_pattern_ops)`,
        `UPDATE ${schema}.job set name = '__state__completed__' || substr(name, 1, position('__state__completed' in name) - 1) WHERE name LIKE '%__state__completed'`
      ],
      uninstall: [
        `UPDATE ${schema}.job set name = substr(name, 21) || '__state__completed' WHERE name LIKE '__state__completed__%'`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `DROP INDEX ${schema}.job_name`,
        `CREATE INDEX job_name ON ${schema}.job (name) WHERE state < 'active'`
      ]
    },
    {
      version: '10',
      previous: '9',
      install: [
        `CREATE INDEX archive_id_idx ON ${schema}.archive(id)`
      ],
      uninstall: [
        `DROP INDEX ${schema}.archive_id_idx`
      ]
    },
    {
      version: '11',
      previous: '10',
      install: [
          `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`
      ],
      uninstall: [
          `DROP INDEX ${schema}.archive_archivedon_idx`
      ]
    }
  ]
}
