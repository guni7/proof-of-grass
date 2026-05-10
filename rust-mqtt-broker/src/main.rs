use rumqttd::{Broker, Config};

fn main() {
    tracing_subscriber::fmt()
        .pretty()
        .with_line_number(false)
        .with_file(false)
        .with_thread_ids(false)
        .with_thread_names(false)
        .init();

    println!("Starting Rust MQTT broker on port 1883...");

    let settings = config::Config::builder()
        .add_source(config::File::with_name("rumqttd.toml"))
        .build()
        .expect("Failed to load rumqttd.toml");

    let rumqttd_config: Config = settings
        .try_deserialize()
        .expect("Failed to parse rumqttd.toml");

    let mut broker = Broker::new(rumqttd_config);

    broker.start().expect("Broker failed to start");
}