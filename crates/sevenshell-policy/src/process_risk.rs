//! What a process-management action could do, before it runs.
//!
//! The monitor's process page reads the host's process table; ending one process is the page's
//! single write, and it is the same shape as the container and workbench gates: a fixed verb with
//! a fixed command behind it (`kill <pid>`, the pid a formatted number, never anything else),
//! decided here rather than by the command classifier because there is no command line for anybody
//! to have read. Ending one process can take a service down, so it is `Destructive` — the matrix
//! can never be configured to run it unattended.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies ending one process.
///
/// There is exactly one verb, so there is exactly one verdict; the function exists so the gate
/// reads the same way the container and workbench gates do, and so a future second verb (a force
/// kill, say) lands beside it with its own named level instead of being argued into this one.
pub fn process_kill() -> RiskAssessment {
    RiskAssessment::from_reasons(vec![RiskReason::new(
        "process.kill",
        "risk.process.kill",
        RiskLevel::Destructive,
    )])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::RiskLevel;

    #[test]
    fn ending_a_process_is_destructive_and_names_its_rule() {
        let verdict = process_kill();
        assert_eq!(verdict.level, RiskLevel::Destructive);
        assert!(verdict.needs_approval(), "the matrix must always ask");
        assert_eq!(verdict.reasons[0].rule_id, "process.kill");
    }
}
