//! Script sources in binary Roblox models, addressed by instance names.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use rbx_dom_weak::{
    WeakDom,
    types::{Ref, Variant},
};

fn read_model(path: &Path) -> io::Result<WeakDom> {
    rbx_binary::from_reader(BufReader::new(File::open(path)?))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn script_at(dom: &WeakDom, path: &[String]) -> io::Result<Ref> {
    let invalid = |reason| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("script path {path:?}: {reason}"),
        )
    };
    if path.is_empty() {
        return Err(invalid("empty path"));
    }
    let mut current = dom.root_ref();
    for name in path {
        let instance = dom
            .get_by_ref(current)
            .expect("the model contains its children");
        let mut matches = instance.children().iter().copied().filter(|child| {
            dom.get_by_ref(*child)
                .expect("the model contains its children")
                .name
                == *name
        });
        current = matches.next().ok_or_else(|| invalid("missing instance"))?;
        if matches.next().is_some() {
            return Err(invalid("ambiguous instance name"));
        }
    }
    let script = dom
        .get_by_ref(current)
        .expect("the resolved instance exists");
    if !matches!(
        script.class.as_str(),
        "Script" | "LocalScript" | "ModuleScript"
    ) {
        return Err(invalid("instance is not a script"));
    }
    Ok(current)
}

pub fn read_sources(path: &Path, script_paths: &[Vec<String>]) -> io::Result<Vec<String>> {
    let dom = read_model(path)?;
    script_paths
        .iter()
        .map(|path| {
            let script = dom
                .get_by_ref(script_at(&dom, path)?)
                .expect("the resolved script exists");
            match script.properties.get(&"Source".into()) {
                Some(Variant::String(source)) => Ok(source.clone()),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("script path {path:?}: Source is not a string"),
                )),
            }
        })
        .collect()
}

pub fn write_sources(path: &Path, scripts: &[(Vec<String>, String)]) -> io::Result<()> {
    let mut dom = read_model(path)?;
    for (script_path, source) in scripts {
        let referent = script_at(&dom, script_path)?;
        dom.get_by_ref_mut(referent)
            .expect("the resolved script exists")
            .properties
            .insert("Source".into(), Variant::String(source.clone()));
    }
    // The temporary file shares the target's filesystem, so replacement is atomic.
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    rbx_binary::to_writer(temporary.as_file_mut(), &dom, dom.root().children())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    temporary
        .as_file()
        .set_permissions(std::fs::metadata(path)?.permissions())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rbx_dom_weak::{InstanceBuilder, WeakDom};
    use std::fs::File;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("plugin.rbxm");
        let dom = WeakDom::new(
            InstanceBuilder::new("Folder")
                .with_name("Plugin")
                .with_child(
                    InstanceBuilder::new("ModuleScript")
                        .with_name("App")
                        .with_property("Source", "return 42"),
                )
                .with_child(
                    InstanceBuilder::new("Script")
                        .with_name("Worker")
                        .with_property("Source", "print('worker')")
                        .with_property("Disabled", true),
                )
                .with_child(
                    InstanceBuilder::new("LocalScript")
                        .with_name("Client")
                        .with_property("Source", "print('client')"),
                )
                .with_child(
                    InstanceBuilder::new("StringValue")
                        .with_name("Settings")
                        .with_property("Value", "keep me"),
                ),
        );
        rbx_binary::to_writer(File::create(&path).unwrap(), &dom, &[dom.root_ref()]).unwrap();
        (directory, path)
    }

    #[test]
    fn reads_requested_sources() {
        let (_directory, path) = fixture();
        assert_eq!(
            read_sources(&path, &[vec!["Plugin".into(), "App".into()]]).unwrap(),
            vec!["return 42"]
        );
    }

    #[test]
    fn writes_only_requested_sources() {
        let (_directory, path) = fixture();
        let before = read_model(&path).unwrap();
        write_sources(
            &path,
            &[(vec!["Plugin".into(), "App".into()], "return 99".into())],
        )
        .unwrap();
        let after = read_model(&path).unwrap();
        assert_eq!(
            read_sources(&path, &[vec!["Plugin".into(), "App".into()]]).unwrap(),
            vec!["return 99"]
        );
        for (old, new) in before.descendants().zip(after.descendants()) {
            assert_eq!(old.name, new.name);
            assert_eq!(old.class, new.class);
            assert_eq!(old.children().len(), new.children().len());
            let mut expected = old.properties.clone();
            if old.name == "App" {
                expected.insert("Source".into(), Variant::String("return 99".into()));
            }
            assert_eq!(expected, new.properties);
        }
        assert_eq!(before.descendants().count(), after.descendants().count());
    }

    #[test]
    fn invalid_paths_preserve_the_original() {
        let (_directory, path) = fixture();
        let original = std::fs::read(&path).unwrap();
        for invalid in [
            vec![],
            vec!["Plugin".into(), "Missing".into()],
            vec!["Plugin".into(), "Settings".into()],
        ] {
            assert!(read_sources(&path, &[invalid.clone()]).is_err());
            assert!(
                write_sources(
                    &path,
                    &[
                        (vec!["Plugin".into(), "App".into()], "changed".into()),
                        (invalid, "invalid".into())
                    ]
                )
                .is_err()
            );
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn refuses_ambiguous_names() {
        let (directory, path) = fixture();
        let mut dom = read_model(&path).unwrap();
        let plugin = dom.root().children()[0];
        dom.insert(
            plugin,
            InstanceBuilder::new("ModuleScript")
                .with_name("App")
                .with_property("Source", "another source"),
        );
        rbx_binary::to_writer(File::create(&path).unwrap(), &dom, dom.root().children()).unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(
            read_sources(&path, &[vec!["Plugin".into(), "App".into()]])
                .unwrap_err()
                .to_string()
                .contains("ambiguous")
        );
        assert!(
            write_sources(
                &path,
                &[(vec!["Plugin".into(), "App".into()], "changed".into())]
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn malformed_models_preserve_the_original() {
        let (_directory, path) = fixture();
        std::fs::write(&path, b"not a binary Roblox model").unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(read_sources(&path, &[vec!["Plugin".into(), "App".into()]]).is_err());
        assert!(
            write_sources(
                &path,
                &[(vec!["Plugin".into(), "App".into()], "changed".into())]
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_replacement_preserves_the_original_and_removes_the_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let (directory, path) = fixture();
        let original = std::fs::read(&path).unwrap();
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(
            write_sources(
                &path,
                &[(vec!["Plugin".into(), "App".into()], "changed".into())]
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
