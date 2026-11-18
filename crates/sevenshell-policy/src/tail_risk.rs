//! What following a file could do, before it runs.
//!
//! Following a file is a fixed verb — `tail -n <lines> -F -- <path>` — with no command line for
//! anybody to have read, so like the container, service and workbench gates it is decided here
//! rather than by the command classifier. The path the verdict is about travels with the decision
//! as its subject, which is what makes the question a person is asked name *which* file is about
//! to be followed rather than "a file".

use sevenshell_types::{RiskAssessment, RiskLevel, RiskReason};

/// Classifies opening a tail. Following a file reads it and keeps reading it; nothing is written
/// and nothing is taken down, so it is `Caution`.
pub fn tail_open() -> RiskAssessment {
    RiskAssessment::from_reasons(vec![RiskReason::new("tail.open", "risk.tail.open", RiskLevel::Caution)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::{PolicyAction, PolicyRule};

    #[test]
    fn opening_a_tail_is_caution_and_names_its_rule() {
        let verdict = tail_open();
        assert_eq!(verdict.level, RiskLevel::Caution);
        assert!(!verdict.needs_approval(), "reading runs unattended by default");
        assert_eq!(verdict.reasons[0].rule_id, "tail.open");
    }

    #[test]
    fn the_default_rule_lets_a_tail_run_unattended() {
        assert_eq!(PolicyRule::default().action_for(tail_open().level), PolicyAction::Allow);
    }

    #[test]
    fn an_installation_that_asks_about_caution_stops_a_tail_too() {
        let asking = PolicyRule {
            caution: PolicyAction::Ask,
            ..PolicyRule::default()
        };
        assert_eq!(asking.action_for(tail_open().level), PolicyAction::Ask);
    }
}
