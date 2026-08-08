use opspilot_remote_adapters::{ProjectDetector, RuntimeType};

#[test]
fn compose_wins_over_node_when_both_are_present() {
    let files = ["package.json", "compose.yaml", "Dockerfile"];
    let result = ProjectDetector.detect(files).unwrap();
    assert_eq!(result.primary, RuntimeType::DockerCompose);
    assert_eq!(
        result.evidence,
        ["compose.yaml", "Dockerfile", "package.json"]
    );
}

#[test]
fn detects_go_python_static_and_generic_deterministically() {
    assert_eq!(
        ProjectDetector.detect(["go.mod"]).unwrap().primary,
        RuntimeType::Go
    );
    assert_eq!(
        ProjectDetector
            .detect(["requirements.txt"])
            .unwrap()
            .primary,
        RuntimeType::Python
    );
    assert_eq!(
        ProjectDetector.detect(["index.html"]).unwrap().primary,
        RuntimeType::StaticSite
    );
    assert_eq!(
        ProjectDetector.detect(Vec::<&str>::new()).unwrap().primary,
        RuntimeType::Generic
    );
}

#[test]
fn detector_rejects_paths_instead_of_recursing_or_accepting_traversal() {
    assert!(ProjectDetector.detect(["../compose.yaml"]).is_err());
    assert!(ProjectDetector.detect(["nested/package.json"]).is_err());
}
