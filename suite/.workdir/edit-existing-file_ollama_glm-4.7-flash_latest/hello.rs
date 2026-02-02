fn main() {
    println!("Hello, world!");
    debug_args(std::env::args().collect::<Vec<_>>());
}

fn debug_args(args: Vec<String>) {
    println!("--- Debug Arguments ---");
    for (i, arg) in args.iter().enumerate() {
        println!("arg[{}]: {}", i, arg);
    }
    println!("--- End Arguments ---");
}
