//! Assemble one Studio capture into a Rojo-built place.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use rbx_dom_weak::{
    InstanceBuilder, WeakDom,
    types::{Ref, Variant},
};
use serde::Deserialize;

#[derive(Deserialize)]
struct CaptureService {
    name: String,
    roots: Vec<usize>,
}

fn invalid_data(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn validate_services(services: &[CaptureService], root_count: usize) -> io::Result<()> {
    let mut names = HashSet::new();
    let mut assigned = vec![false; root_count];
    for service in services {
        if service.name.is_empty() || !names.insert(&service.name) {
            return Err(invalid_data(
                "capture service names must be nonempty and unique",
            ));
        }
        for index in &service.roots {
            let assigned = assigned
                .get_mut(*index)
                .ok_or_else(|| invalid_data("capture root index is out of range"))?;
            if *assigned {
                return Err(invalid_data(
                    "capture root belongs to more than one service",
                ));
            }
            *assigned = true;
        }
    }
    if assigned.contains(&false) {
        return Err(invalid_data("every capture root must belong to a service"));
    }
    Ok(())
}

fn restore_declared(
    dom: &mut WeakDom,
    declared: Ref,
    parent: Ref,
    replacements: &mut HashMap<Ref, Ref>,
) {
    let original = dom.get_by_ref(declared).expect("the base node exists");
    let matched = dom
        .get_by_ref(parent)
        .expect("the captured parent exists")
        .children()
        .iter()
        .copied()
        .find(|child| dom.get_by_ref(*child).expect("the child exists").name == original.name);
    if let Some(matched) = matched {
        let children = original.children().to_vec();
        let class = original.class;
        let properties = original.properties.clone();
        let captured = dom
            .get_by_ref_mut(matched)
            .expect("the captured node exists");
        if captured.class != class {
            captured.class = class;
            captured.properties = properties;
        }
        replacements.insert(declared, matched);
        for child in children {
            restore_declared(dom, child, matched, replacements);
        }
        dom.destroy(declared);
    } else {
        dom.transfer_within(declared, parent);
    }
}

pub fn assemble_place(
    base_path: &Path,
    model: &[u8],
    services_json: &str,
    output_path: &Path,
) -> io::Result<()> {
    let mut dom =
        rbx_binary::from_reader(BufReader::new(File::open(base_path)?)).map_err(invalid_data)?;
    let mut capture = rbx_binary::from_reader(model).map_err(invalid_data)?;
    let roots = capture.root().children().to_vec();
    let services: Vec<CaptureService> =
        serde_json::from_str(services_json).map_err(invalid_data)?;
    validate_services(&services, roots.len())?;
    let mut replacements = HashMap::new();
    for service in services {
        let parent = dom
            .root()
            .children()
            .iter()
            .copied()
            .find(|child| dom.get_by_ref(*child).expect("the service exists").name == service.name)
            .unwrap_or_else(|| dom.insert(dom.root_ref(), InstanceBuilder::new(service.name)));
        let declared = dom
            .get_by_ref(parent)
            .expect("the service exists")
            .children()
            .to_vec();
        for child in &declared {
            dom.transfer_within(*child, Ref::none());
        }
        for index in service.roots {
            capture.transfer(roots[index], &mut dom, parent);
        }
        for child in declared {
            restore_declared(&mut dom, child, parent, &mut replacements);
        }
    }
    let referents: Vec<_> = dom
        .descendants()
        .map(rbx_dom_weak::Instance::referent)
        .collect();
    for referent in referents {
        for property in dom
            .get_by_ref_mut(referent)
            .expect("the node exists")
            .properties
            .values_mut()
        {
            if let Variant::Ref(target) = property
                && let Some(replacement) = replacements.get(target)
            {
                *target = *replacement;
            }
        }
    }
    // The temporary file shares the target's filesystem, so replacement is atomic.
    let directory = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    rbx_binary::to_writer(temporary.as_file_mut(), &dom, dom.root().children())
        .map_err(invalid_data)?;
    match std::fs::metadata(output_path) {
        Ok(metadata) => temporary
            .as_file()
            .set_permissions(metadata.permissions())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist(output_path)
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rbx_dom_weak::{
        InstanceBuilder, WeakDom,
        types::{Ref, Variant},
    };
    use std::fs::File;

    fn write_model(path: &Path, dom: &WeakDom) {
        rbx_binary::to_writer(File::create(path).unwrap(), dom, dom.root().children()).unwrap();
    }

    fn model_bytes(dom: &WeakDom) -> Vec<u8> {
        let mut bytes = Vec::new();
        rbx_binary::to_writer(&mut bytes, dom, dom.root().children()).unwrap();
        bytes
    }

    fn child(dom: &WeakDom, parent: Ref, name: &str) -> Ref {
        *dom.get_by_ref(parent)
            .unwrap()
            .children()
            .iter()
            .find(|referent| dom.get_by_ref(**referent).unwrap().name == name)
            .unwrap()
    }

    #[test]
    fn replaces_children_with_the_capture_and_keeps_declared_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(
                InstanceBuilder::new("ServerScriptService").with_child(
                    InstanceBuilder::new("Folder")
                        .with_name("Declared")
                        .with_child(
                            InstanceBuilder::new("ModuleScript")
                                .with_name("Removed")
                                .with_property("Source", "return 'base'"),
                        )
                        .with_child(
                            InstanceBuilder::new("ModuleScript")
                                .with_name("Changed")
                                .with_property("Source", "return 'old'"),
                        ),
                ),
            ),
        );
        write_model(&base_path, &base);
        let capture = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(
                InstanceBuilder::new("Folder")
                    .with_name("Declared")
                    .with_child(
                        InstanceBuilder::new("ModuleScript")
                            .with_name("Changed")
                            .with_property("Source", "return 'Studio'"),
                    )
                    .with_child(InstanceBuilder::new("Folder").with_name("Added")),
            ),
        );

        assemble_place(
            &base_path,
            &model_bytes(&capture),
            r#"[{"name":"ServerScriptService","roots":[0]}]"#,
            &output_path,
        )
        .unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let service = child(&assembled, assembled.root_ref(), "ServerScriptService");
        let declared = child(&assembled, service, "Declared");
        let removed = child(&assembled, declared, "Removed");
        let changed = child(&assembled, declared, "Changed");
        assert_eq!(assembled.get_by_ref(declared).unwrap().children().len(), 3);
        assert_eq!(assembled.get_by_ref(removed).unwrap().class, "ModuleScript");
        assert_eq!(
            assembled.get_by_ref(changed).unwrap().properties[&"Source".into()],
            "return 'Studio'".into()
        );
        assert_eq!(
            assembled
                .get_by_ref(child(&assembled, declared, "Added"))
                .unwrap()
                .class,
            "Folder"
        );
    }

    #[test]
    fn restores_declared_classes_and_retargets_their_base_references() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let target = InstanceBuilder::new("Part").with_name("Target");
        let target_ref = target.referent();
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(
                InstanceBuilder::new("Workspace")
                    .with_property("Gravity", 101.0_f32)
                    .with_child(
                        InstanceBuilder::new("Model")
                            .with_name("Declared")
                            .with_property("PrimaryPart", target_ref)
                            .with_child(target)
                            .with_child(
                                InstanceBuilder::new("ObjectValue")
                                    .with_name("KeptReference")
                                    .with_property("Value", target_ref),
                            ),
                    ),
            ),
        );
        write_model(&base_path, &base);
        let capture = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(
                InstanceBuilder::new("Folder")
                    .with_name("Declared")
                    .with_child(InstanceBuilder::new("Part").with_name("Target"))
                    .with_child(InstanceBuilder::new("Folder").with_name("Added")),
            ),
        );

        assemble_place(
            &base_path,
            &model_bytes(&capture),
            r#"[{"name":"Workspace","roots":[0]}]"#,
            &output_path,
        )
        .unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let workspace = child(&assembled, assembled.root_ref(), "Workspace");
        let declared = child(&assembled, workspace, "Declared");
        let target = child(&assembled, declared, "Target");
        let kept = child(&assembled, declared, "KeptReference");
        assert_eq!(assembled.get_by_ref(declared).unwrap().class, "Model");
        assert_eq!(assembled.get_by_ref(declared).unwrap().children().len(), 3);
        assert_eq!(
            assembled.get_by_ref(workspace).unwrap().properties[&"Gravity".into()],
            Variant::Float32(101.0)
        );
        assert_eq!(
            assembled.get_by_ref(declared).unwrap().properties[&"PrimaryPart".into()],
            Variant::Ref(target)
        );
        assert_eq!(
            assembled.get_by_ref(kept).unwrap().properties[&"Value".into()],
            Variant::Ref(target)
        );
    }

    #[test]
    fn preserves_joints_and_references_between_captured_services() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("Workspace")),
        );
        write_model(&base_path, &base);
        let left = InstanceBuilder::new("Part").with_name("Left");
        let right = InstanceBuilder::new("Part").with_name("Right");
        let left_ref = left.referent();
        let right_ref = right.referent();
        let capture = WeakDom::new(
            InstanceBuilder::new("DataModel")
                .with_child(left)
                .with_child(right)
                .with_child(
                    InstanceBuilder::new("WeldConstraint")
                        .with_name("Joint")
                        .with_property("Part0", left_ref)
                        .with_property("Part1", right_ref),
                )
                .with_child(
                    InstanceBuilder::new("ObjectValue")
                        .with_name("Link")
                        .with_property("Value", left_ref),
                ),
        );

        assemble_place(
            &base_path,
            &model_bytes(&capture),
            r#"[{"name":"Workspace","roots":[0,2]},{"name":"ServerStorage","roots":[1,3]}]"#,
            &output_path,
        )
        .unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let workspace = child(&assembled, assembled.root_ref(), "Workspace");
        let storage = child(&assembled, assembled.root_ref(), "ServerStorage");
        let left = child(&assembled, workspace, "Left");
        let right = child(&assembled, storage, "Right");
        let joint = assembled
            .get_by_ref(child(&assembled, workspace, "Joint"))
            .unwrap();
        let link = assembled
            .get_by_ref(child(&assembled, storage, "Link"))
            .unwrap();
        assert_eq!(joint.properties[&"Part0".into()], Variant::Ref(left));
        assert_eq!(joint.properties[&"Part1".into()], Variant::Ref(right));
        assert_eq!(link.properties[&"Value".into()], Variant::Ref(left));
    }

    #[test]
    fn refuses_invalid_root_mappings_without_replacing_the_output() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("Workspace")),
        );
        write_model(&base_path, &base);
        let capture = model_bytes(&WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("Part")),
        ));
        std::fs::write(&output_path, b"original output").unwrap();

        for services in [
            r#"[{"name":"Workspace","roots":[1]}]"#,
            r#"[{"name":"Workspace","roots":[0,0]}]"#,
            r#"[{"name":"Workspace","roots":[]}]"#,
            r#"[{"name":"Workspace","roots":[0]},{"name":"Workspace","roots":[]}]"#,
            r#"[{"name":"","roots":[0]}]"#,
        ] {
            assert!(assemble_place(&base_path, &capture, services, &output_path).is_err());
            assert_eq!(std::fs::read(&output_path).unwrap(), b"original output");
        }
    }

    #[test]
    fn unreadable_inputs_preserve_the_output_and_a_failed_replace_leaves_no_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let missing_path = directory.path().join("missing.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("Workspace")),
        );
        write_model(&base_path, &base);
        let capture = model_bytes(&WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("Part")),
        ));
        let services = r#"[{"name":"Workspace","roots":[0]}]"#;
        std::fs::write(&output_path, b"original output").unwrap();

        assert!(assemble_place(&missing_path, &capture, services, &output_path).is_err());
        assert!(assemble_place(&base_path, b"not a model", services, &output_path).is_err());
        assert!(assemble_place(&base_path, &capture, "invalid json", &output_path).is_err());
        assert_eq!(std::fs::read(&output_path).unwrap(), b"original output");
        std::fs::remove_file(&output_path).unwrap();
        std::fs::create_dir(&output_path).unwrap();

        assert!(assemble_place(&base_path, &capture, services, &output_path).is_err());
        assert!(output_path.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn can_replace_the_base_file_with_an_empty_capture() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(
                InstanceBuilder::new("ServerScriptService").with_child(
                    InstanceBuilder::new("ModuleScript")
                        .with_name("Declared")
                        .with_property("Source", "return 1"),
                ),
            ),
        );
        write_model(&path, &base);
        let capture = model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel")));

        assemble_place(
            &path,
            &capture,
            r#"[{"name":"ServerScriptService","roots":[]}]"#,
            &path,
        )
        .unwrap();

        assert_eq!(
            crate::model::read_sources(
                &path,
                &[vec!["ServerScriptService".into(), "Declared".into()]]
            )
            .unwrap(),
            vec!["return 1"]
        );
    }
}
