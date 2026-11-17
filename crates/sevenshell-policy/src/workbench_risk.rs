//! What a desktop workbench action could do, before it runs.
//!
//! The workbench is a front page, and almost everything on it reads rather than writes — the
//! sample, the mark, the file entries are surfaces the connection already carries. The one
//! exception is the power action, and it is the same shape as a container action: a fixed verb
//! with a fixed command behind it, decided here rather than by the risk classifier, because
//! there is no command line for anybody to have read.
//!
//! A machine losing power is not like a container losing one process: sessions die, writes that
//! were in flight may not land, and a machine that comes back up is somebody's morning to check.
//! Both verbs are `Destructive`, so the matrix can never be configured to run them unattended —
//! the strictest-layer rule raises destructive verdicts to at least a question.

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies one workbench power action.
///
/// Unknown verbs are `Catastrophic`, never run: a caller this table has not learned about has no
/// command behind it worth guessing at, and a gate that guessed would be a gate that ran
/// something nobody named.
pub fn workbench_action(action: &str) -> RiskAssessment {
    let action = action.trim().to_ascii_lowercase();
    let verdict = match action.as_str() {
        "reboot" => ("workbench.reboot", "risk.workbench.reboot", RiskLevel::Destructive),
        "shutdown" => ("workbench.shutdown", "risk.workbench.shutdown", RiskLevel::Destructive),
        _ => ("workbench.unknown", "risk.workbench.unknown", RiskLevel::Catastrophic),
    };
    RiskAssessment::from_reasons(vec![RiskReason::new(verdict.0, verdict.1, verdict.2)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::RiskLevel;

    #[test]
    fn both_power_verbs_are_destructive_and_name_their_rule() {
        for action in ["reboot", "shutdown", "Reboot", " SHUTDOWN "] {
            let verdict = workbench_action(action);
            assert_eq!(verdict.level, RiskLevel::Destructive, "{action} is destructive");
            assert!(verdict.needs_approval(), "{action} always asks a person");
        }
    }

    #[test]
    fn reboot_and_shutdown_are_told_apart() {
        assert_eq!(workbench_action("reboot").reasons[0].rule_id, "workbench.reboot");
        assert_eq!(workbench_action("shutdown").reasons[0].rule_id, "workbench.shutdown");
    }

    #[test]
    fn an_unknown_verb_is_catastrophic() {
        let verdict = workbench_action("format");
        assert_eq!(verdict.level, RiskLevel::Catastrophic);
        assert!(verdict.needs_approval());
    }
}
