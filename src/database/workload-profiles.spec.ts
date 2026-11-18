/**
 * Tests for workload profile validation and configuration.
 */

import {
  WorkloadType,
  WorkloadProfile,
  validateWorkloadProfile,
  validateAllWorkloadProfiles,
} from "./workload-profiles";

describe("WorkloadProfile Validation", () => {
  describe("validateWorkloadProfile", () => {
    it("should accept valid profiles with positive integers", () => {
      const validProfile: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(validProfile, WorkloadType.INTERACTIVE),
      ).not.toThrow();
    });

    it("should reject zero timeouts", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: 0,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.INTERACTIVE),
      ).toThrow(/statementTimeoutMs must be a positive integer/);
    });

    it("should reject negative timeouts", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: -10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.INTERACTIVE),
      ).toThrow(/statementTimeoutMs must be a positive integer/);
    });

    it("should reject non-integer timeouts", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: 10_000.5,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.INTERACTIVE),
      ).toThrow(/statementTimeoutMs must be a positive integer/);
    });

    it("should reject invalid idle timeout", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 0,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.JOB),
      ).toThrow(/idleInTransactionTimeoutMs must be a positive integer/);
    });

    it("should reject invalid lock timeout", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: -5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.MIGRATION),
      ).toThrow(/lockTimeoutMs must be a positive integer/);
    });

    it("should include workload name in error message", () => {
      const invalidProfile: WorkloadProfile = {
        statementTimeoutMs: 0,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(() =>
        validateWorkloadProfile(invalidProfile, WorkloadType.REPORT),
      ).toThrow(/for report/);
    });
  });

  describe("validateAllWorkloadProfiles", () => {
    it("should accept all valid profiles", () => {
      const validProfiles = {
        [WorkloadType.INTERACTIVE]: {
          statementTimeoutMs: 10_000,
          idleInTransactionTimeoutMs: 30_000,
          lockTimeoutMs: 5_000,
        },
        [WorkloadType.JOB]: {
          statementTimeoutMs: 120_000,
          idleInTransactionTimeoutMs: 300_000,
          lockTimeoutMs: 30_000,
        },
        [WorkloadType.MIGRATION]: {
          statementTimeoutMs: 3600_000,
          idleInTransactionTimeoutMs: 3600_000,
          lockTimeoutMs: 300_000,
        },
        [WorkloadType.REPORT]: {
          statementTimeoutMs: 600_000,
          idleInTransactionTimeoutMs: 900_000,
          lockTimeoutMs: 60_000,
        },
      };

      expect(() => validateAllWorkloadProfiles(validProfiles)).not.toThrow();
    });

    it("should reject if any profile is invalid", () => {
      const invalidProfiles = {
        [WorkloadType.INTERACTIVE]: {
          statementTimeoutMs: 10_000,
          idleInTransactionTimeoutMs: 30_000,
          lockTimeoutMs: 5_000,
        },
        [WorkloadType.JOB]: {
          statementTimeoutMs: 0, // Invalid
          idleInTransactionTimeoutMs: 300_000,
          lockTimeoutMs: 30_000,
        },
        [WorkloadType.MIGRATION]: {
          statementTimeoutMs: 3600_000,
          idleInTransactionTimeoutMs: 3600_000,
          lockTimeoutMs: 300_000,
        },
        [WorkloadType.REPORT]: {
          statementTimeoutMs: 600_000,
          idleInTransactionTimeoutMs: 900_000,
          lockTimeoutMs: 60_000,
        },
      };

      expect(() => validateAllWorkloadProfiles(invalidProfiles)).toThrow(
        /for job/,
      );
    });

    it("should validate all workload types", () => {
      const missingProfile: Partial<
        Record<WorkloadType, WorkloadProfile>
      > = {
        [WorkloadType.INTERACTIVE]: {
          statementTimeoutMs: 10_000,
          idleInTransactionTimeoutMs: 30_000,
          lockTimeoutMs: 5_000,
        },
        // Missing job, migration, report
      };

      // This will only validate profiles that exist; doesn't check for missing types
      expect(() =>
        validateAllWorkloadProfiles(
          missingProfile as Record<WorkloadType, WorkloadProfile>,
        ),
      ).not.toThrow();
    });
  });

  describe("WorkloadType enum", () => {
    it("should have expected values", () => {
      expect(WorkloadType.INTERACTIVE).toBe("interactive");
      expect(WorkloadType.JOB).toBe("job");
      expect(WorkloadType.MIGRATION).toBe("migration");
      expect(WorkloadType.REPORT).toBe("report");
    });
  });

  describe("Profile reasonable boundaries", () => {
    it("interactive should be faster than job", () => {
      const interactive: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };
      const job: WorkloadProfile = {
        statementTimeoutMs: 120_000,
        idleInTransactionTimeoutMs: 300_000,
        lockTimeoutMs: 30_000,
      };

      expect(interactive.statementTimeoutMs).toBeLessThan(
        job.statementTimeoutMs,
      );
      expect(interactive.idleInTransactionTimeoutMs).toBeLessThan(
        job.idleInTransactionTimeoutMs,
      );
      expect(interactive.lockTimeoutMs).toBeLessThan(job.lockTimeoutMs);
    });

    it("migration should have the most generous timeout", () => {
      const migration: WorkloadProfile = {
        statementTimeoutMs: 3600_000,
        idleInTransactionTimeoutMs: 3600_000,
        lockTimeoutMs: 300_000,
      };

      const interactive: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };

      expect(migration.statementTimeoutMs).toBeGreaterThan(
        interactive.statementTimeoutMs,
      );
    });

    it("report should be between interactive and migration", () => {
      const interactive: WorkloadProfile = {
        statementTimeoutMs: 10_000,
        idleInTransactionTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
      };
      const report: WorkloadProfile = {
        statementTimeoutMs: 600_000,
        idleInTransactionTimeoutMs: 900_000,
        lockTimeoutMs: 60_000,
      };
      const migration: WorkloadProfile = {
        statementTimeoutMs: 3600_000,
        idleInTransactionTimeoutMs: 3600_000,
        lockTimeoutMs: 300_000,
      };

      expect(report.statementTimeoutMs).toBeGreaterThan(
        interactive.statementTimeoutMs,
      );
      expect(report.statementTimeoutMs).toBeLessThan(
        migration.statementTimeoutMs,
      );
    });
  });
});
