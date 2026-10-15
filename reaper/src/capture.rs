//! Assemble one Studio capture into a Rojo-built place.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use rbx_dom_weak::{
    InstanceBuilder, WeakDom,
    types::{Attributes, Ref, Tags, Variant},
};
use serde::Deserialize;

#[derive(Deserialize)]
struct CaptureService {
    name: String,
    roots: Vec<usize>,
    #[serde(default)]
    properties: Vec<CaptureProperty>,
    attributes: Option<Vec<CaptureProperty>>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CaptureProperty {
    name: String,
    value: CaptureValue,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CaptureValue {
    Value(Variant),
    Encoded(EncodedValue),
}

#[derive(Deserialize)]
enum EncodedValue {
    InstanceRef(usize),
    ServiceRef(String),
    CapabilityBits(Vec<u8>),
}

fn resolve_value(
    value: &CaptureValue,
    dom: &WeakDom,
    capture: &WeakDom,
    roots: &[Ref],
) -> io::Result<Variant> {
    match value {
        CaptureValue::Value(value) => Ok(value.clone()),
        CaptureValue::Encoded(EncodedValue::InstanceRef(index)) => {
            let carrier = capture
                .get_by_ref(roots[*index])
                .ok_or_else(|| invalid_data("capture reference carrier is missing"))?;
            if carrier.class != "ObjectValue" || !carrier.children().is_empty() {
                return Err(invalid_data(
                    "capture reference carrier must be an ObjectValue without children",
                ));
            }
            let Some(Variant::Ref(target)) = carrier.properties.get(&"Value".into()) else {
                return Err(invalid_data("capture reference carrier has no Value"));
            };
            if target.is_some() && dom.get_by_ref(*target).is_none() {
                return Err(invalid_data(
                    "capture reference target is not in the assembled place",
                ));
            }
            Ok(Variant::Ref(*target))
        }
        CaptureValue::Encoded(EncodedValue::ServiceRef(class)) => {
            let service = dom.root().children().iter().find(|referent| {
                dom.get_by_ref(**referent)
                    .expect("the service exists")
                    .class
                    .as_str()
                    == class
            });
            service
                .copied()
                .map(Variant::Ref)
                .ok_or_else(|| invalid_data("capture service reference is missing"))
        }
        CaptureValue::Encoded(EncodedValue::CapabilityBits(bits)) => {
            let value = bits.iter().try_fold(0_u64, |value, bit| {
                1_u64
                    .checked_shl(u32::from(*bit))
                    .map(|flag| value | flag)
                    .ok_or_else(|| invalid_data("capture capability bit exceeds 63"))
            })?;
            Ok(Variant::SecurityCapabilities(
                rbx_dom_weak::types::SecurityCapabilities::from_bits(value),
            ))
        }
    }
}

fn invalid_data(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn clock_time(time_of_day: &str) -> io::Result<f32> {
    let parts = time_of_day
        .split(':')
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(invalid_data)?;
    let [hours, minutes, seconds] = parts.as_slice() else {
        return Err(invalid_data(
            "Lighting.TimeOfDay must contain hours, minutes, and seconds",
        ));
    };
    if !(0.0..24.0).contains(hours)
        || !(0.0..60.0).contains(minutes)
        || !(0.0..60.0).contains(seconds)
    {
        return Err(invalid_data("Lighting.TimeOfDay is outside one day"));
    }
    Ok((hours + minutes / 60.0 + seconds / 3600.0) as f32)
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
        let carriers = service
            .properties
            .iter()
            .filter_map(|property| match &property.value {
                CaptureValue::Encoded(EncodedValue::InstanceRef(index)) => Some(index),
                _ => None,
            });
        for index in service.roots.iter().chain(carriers) {
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
    let mut parents = Vec::new();
    for service in &services {
        let parent = dom
            .root()
            .children()
            .iter()
            .copied()
            .find(|child| {
                dom.get_by_ref(*child)
                    .expect("the service exists")
                    .class
                    .as_str()
                    == service.name
            })
            .unwrap_or_else(|| dom.insert(dom.root_ref(), InstanceBuilder::new(&service.name)));
        let declared = dom
            .get_by_ref(parent)
            .expect("the service exists")
            .children()
            .to_vec();
        for child in &declared {
            dom.transfer_within(*child, Ref::none());
        }
        for index in &service.roots {
            capture.transfer(roots[*index], &mut dom, parent);
        }
        for child in declared {
            restore_declared(&mut dom, child, parent, &mut replacements);
        }
        parents.push(parent);
    }
    for (service, parent) in services.iter().zip(parents) {
        let properties = service
            .properties
            .iter()
            .map(|property| {
                Ok((
                    &property.name,
                    resolve_value(&property.value, &dom, &capture, &roots)?,
                ))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let attributes = service
            .attributes
            .as_ref()
            .map(|attributes| {
                attributes
                    .iter()
                    .map(|entry| match &entry.value {
                        CaptureValue::Value(value) => Ok((entry.name.clone(), value.clone())),
                        CaptureValue::Encoded(_) => {
                            Err(invalid_data("capture attributes cannot contain references"))
                        }
                    })
                    .collect::<io::Result<Attributes>>()
            })
            .transpose()?;
        let instance = dom.get_by_ref_mut(parent).expect("the service exists");
        for (name, value) in properties {
            if name == "Name" {
                let Variant::String(name) = value else {
                    return Err(invalid_data("capture service Name must be a string"));
                };
                instance.name = name;
            } else {
                // Lighting's serialized TimeOfDay and Rojo's ClockTime describe one value.
                if instance.class == "Lighting"
                    && name == "TimeOfDay"
                    && let Variant::String(time) = &value
                {
                    instance
                        .properties
                        .insert("ClockTime".into(), Variant::Float32(clock_time(time)?));
                }
                instance.properties.insert(name.as_str().into(), value);
            }
        }
        if let Some(attributes) = attributes {
            instance
                .properties
                .insert("Attributes".into(), Variant::Attributes(attributes));
        }
        if let Some(tags) = &service.tags {
            instance
                .properties
                .insert("Tags".into(), Variant::Tags(Tags::from(tags.clone())));
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
    fn applies_a_runtime_serialized_service_frame_and_structured_attributes() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel").with_child(InstanceBuilder::new("SoundService")),
        );
        write_model(&base_path, &base);
        let capture = model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel")));
        assemble_place(&base_path, &capture,
            r#"[{"name":"SoundService","roots":[],"properties":[{"name":"ListenerCFrame","value":{"CFrame":{"position":[1,2,3],"orientation":[[1,0,0],[0,1,0],[0,0,1]]}}}],"attributes":[{"name":"Wind","value":{"Vector3":[1,-2,3]}},{"name":"Frame","value":{"CFrame":{"position":[1,2,3],"orientation":[[1,0,0],[0,1,0],[0,0,1]]}}}]}]"#,
            &output_path).unwrap();
        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let sound = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "SoundService"))
            .unwrap();
        let frame = rbx_dom_weak::types::CFrame::new(
            rbx_dom_weak::types::Vector3::new(1.0, 2.0, 3.0),
            rbx_dom_weak::types::Matrix3::identity(),
        );
        assert_eq!(
            sound.properties[&"ListenerCFrame".into()],
            Variant::CFrame(frame)
        );
        assert_eq!(
            sound.properties[&"Attributes".into()],
            Variant::Attributes(
                Attributes::new()
                    .with("Wind", rbx_dom_weak::types::Vector3::new(1.0, -2.0, 3.0))
                    .with("Frame", frame)
            )
        );
    }

    #[test]
    fn applies_readable_service_metadata_and_keeps_unreadable_base_properties() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel")
                .with_child(
                    InstanceBuilder::new("Lighting")
                        .with_property("ClockTime", 9.0_f32)
                        .with_property("Technology", rbx_dom_weak::types::Enum::from_u32(3))
                        .with_property(
                            "Attributes",
                            rbx_dom_weak::types::Attributes::new().with("Removed", true),
                        )
                        .with_property(
                            "Tags",
                            rbx_dom_weak::types::Tags::from(vec!["old".to_owned()]),
                        ),
                )
                .with_child(
                    InstanceBuilder::new("Workspace")
                        .with_property("StreamingTargetRadius", 512_i32),
                ),
        );
        write_model(&base_path, &base);
        let capture = model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel")));

        assemble_place(
            &base_path,
            &capture,
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"ClockTime","value":{"Float32":13.5}},{"name":"Ambient","value":{"Color3":[0.25,0.5,0.75]}}],"attributes":[{"name":"Edited","value":{"String":"from Studio"}}],"tags":["new"],"unreadableProperties":["Technology"]},{"name":"Workspace","roots":[],"properties":[],"unreadableProperties":["StreamingTargetRadius"]}]"#,
            &output_path,
        ).unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let lighting = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "Lighting"))
            .unwrap();
        let workspace = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "Workspace"))
            .unwrap();
        assert_eq!(
            lighting.properties[&"ClockTime".into()],
            Variant::Float32(13.5)
        );
        assert_eq!(
            lighting.properties[&"Ambient".into()],
            Variant::Color3(rbx_dom_weak::types::Color3::new(0.25, 0.5, 0.75))
        );
        assert_eq!(
            lighting.properties[&"Technology".into()],
            Variant::Enum(rbx_dom_weak::types::Enum::from_u32(3))
        );
        assert_eq!(
            lighting.properties[&"Attributes".into()],
            Variant::Attributes(rbx_dom_weak::types::Attributes::new().with(
                "Edited",
                rbx_dom_weak::types::BinaryString::from(b"from Studio".as_slice())
            ))
        );
        assert_eq!(
            lighting.properties[&"Tags".into()],
            Variant::Tags(rbx_dom_weak::types::Tags::from(vec!["new".to_owned()]))
        );
        assert_eq!(
            workspace.properties[&"StreamingTargetRadius".into()],
            Variant::Int32(512)
        );
    }

    #[test]
    fn consumes_reference_carriers_without_persisting_them_and_can_clear_service_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        let base = WeakDom::new(
            InstanceBuilder::new("DataModel")
                .with_child(InstanceBuilder::new("Workspace"))
                .with_child(
                    InstanceBuilder::new("SoundService")
                        .with_property("Tags", Tags::from(vec!["old".to_owned()]))
                        .with_property("Attributes", Attributes::new().with("Old", true)),
                ),
        );
        write_model(&base_path, &base);
        let target = InstanceBuilder::new("Part").with_name("Target");
        let target_ref = target.referent();
        let capture = model_bytes(&WeakDom::new(
            InstanceBuilder::new("DataModel")
                .with_child(target)
                .with_child(
                    InstanceBuilder::new("ObjectValue")
                        .with_name("ReferenceCarrier")
                        .with_property("Value", target_ref),
                ),
        ));

        assemble_place(
            &base_path,
            &capture,
            r#"[{"name":"Workspace","roots":[0]},{"name":"SoundService","roots":[],"properties":[{"name":"ListenerObject","value":{"InstanceRef":1}}],"attributes":[],"tags":[]}]"#,
            &output_path,
        ).unwrap();

        let assembled = rbx_binary::from_reader(File::open(&output_path).unwrap()).unwrap();
        let workspace = child(&assembled, assembled.root_ref(), "Workspace");
        let sound = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "SoundService"))
            .unwrap();
        assert_eq!(
            sound.properties[&"ListenerObject".into()],
            Variant::Ref(child(&assembled, workspace, "Target"))
        );
        assert_eq!(sound.children().len(), 0);
        assert_eq!(
            sound.properties[&"Attributes".into()],
            Variant::Attributes(Attributes::new())
        );
        assert_eq!(sound.properties[&"Tags".into()], Variant::Tags(Tags::new()));
        assert!(
            !assembled
                .descendants()
                .any(|instance| instance.name == "ReferenceCarrier")
        );

        assemble_place(
            &output_path,
            &model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel"))),
            r#"[{"name":"SoundService","roots":[],"properties":[{"name":"ListenerObject","value":{"Ref":"00000000000000000000000000000000"}}]}]"#,
            &output_path,
        ).unwrap();
        let cleared = rbx_binary::from_reader(File::open(&output_path).unwrap()).unwrap();
        let sound = cleared
            .get_by_ref(child(&cleared, cleared.root_ref(), "SoundService"))
            .unwrap();
        assert_eq!(
            sound.properties[&"ListenerObject".into()],
            Variant::Ref(Ref::none())
        );
    }

    #[test]
    fn applies_metadata_to_a_project_service_with_a_custom_name() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        write_model(
            &base_path,
            &WeakDom::new(
                InstanceBuilder::new("DataModel").with_child(
                    InstanceBuilder::new("Lighting")
                        .with_name("Environment")
                        .with_property("Brightness", 1.0_f32),
                ),
            ),
        );

        assemble_place(
            &base_path,
            &model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel"))),
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"Name","value":{"String":"Environment"}},{"name":"Brightness","value":{"Float32":3.5}}]}]"#,
            &output_path,
        ).unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        assert_eq!(assembled.root().children().len(), 1);
        let lighting = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "Environment"))
            .unwrap();
        assert_eq!(lighting.class, "Lighting");
        assert_eq!(
            lighting.properties[&"Brightness".into()],
            Variant::Float32(3.5)
        );
    }

    #[test]
    fn invalid_service_metadata_preserves_the_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        write_model(&base_path, &WeakDom::new(InstanceBuilder::new("DataModel")));
        std::fs::write(&output_path, b"original output").unwrap();
        let capture = model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel")));
        for metadata in [
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"TimeOfDay","value":{"String":"invalid"}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"TimeOfDay","value":{"String":"24:00:00"}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"Name","value":{"Bool":false}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"Capabilities","value":{"CapabilityBits":[64]}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"Target","value":{"ServiceRef":"Missing"}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"attributes":[{"name":"Invalid","value":{"ServiceRef":"Lighting"}}]}]"#,
            r#"[{"name":"Lighting","roots":[],"tags":"invalid"}]"#,
        ] {
            assert!(assemble_place(&base_path, &capture, metadata, &output_path).is_err());
            assert_eq!(std::fs::read(&output_path).unwrap(), b"original output");
        }
    }

    #[test]
    fn updates_a_project_clock_time_from_its_runtime_serialized_time_of_day() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        write_model(
            &base_path,
            &WeakDom::new(
                InstanceBuilder::new("DataModel").with_child(
                    InstanceBuilder::new("Lighting").with_property("ClockTime", 9.0_f32),
                ),
            ),
        );

        assemble_place(
            &base_path,
            &model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel"))),
            r#"[{"name":"Lighting","roots":[],"properties":[{"name":"TimeOfDay","value":{"String":"13:30:00"}}]}]"#,
            &output_path,
        ).unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let lighting = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "Lighting"))
            .unwrap();
        assert_eq!(
            lighting.properties[&"ClockTime".into()],
            Variant::Float32(13.5)
        );
        assert_eq!(
            lighting.properties[&"TimeOfDay".into()],
            Variant::String("13:30:00".to_owned())
        );
    }

    #[test]
    fn retains_integer_and_capability_precision_and_resolves_service_references() {
        let directory = tempfile::tempdir().unwrap();
        let base_path = directory.path().join("base.rbxl");
        let output_path = directory.path().join("place.rbxl");
        write_model(&base_path, &WeakDom::new(InstanceBuilder::new("DataModel")));
        let capture = model_bytes(&WeakDom::new(InstanceBuilder::new("DataModel")));

        assemble_place(
            &base_path,
            &capture,
            r#"[{"name":"SoundService","roots":[],"properties":[{"name":"ListenerObject","value":{"ServiceRef":"Lighting"}}]},{"name":"Lighting","roots":[],"properties":[{"name":"Name","value":{"String":"Lighting"}},{"name":"SourceAssetId","value":{"Int64":9007199254740991}},{"name":"Capabilities","value":{"CapabilityBits":[0,31,63]}},{"name":"GlobalShadows","value":{"Bool":false}}]}]"#,
            &output_path,
        ).unwrap();

        let assembled = rbx_binary::from_reader(File::open(output_path).unwrap()).unwrap();
        let lighting_ref = child(&assembled, assembled.root_ref(), "Lighting");
        let lighting = assembled.get_by_ref(lighting_ref).unwrap();
        let sound = assembled
            .get_by_ref(child(&assembled, assembled.root_ref(), "SoundService"))
            .unwrap();
        assert_eq!(
            lighting.properties[&"SourceAssetId".into()],
            Variant::Int64(9_007_199_254_740_991)
        );
        assert_eq!(
            lighting.properties[&"Capabilities".into()],
            Variant::SecurityCapabilities(rbx_dom_weak::types::SecurityCapabilities::from_bits(
                0x8000_0000_8000_0001
            ))
        );
        assert_eq!(
            lighting.properties[&"GlobalShadows".into()],
            Variant::Bool(false)
        );
        assert_eq!(
            sound.properties[&"ListenerObject".into()],
            Variant::Ref(lighting_ref)
        );
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
