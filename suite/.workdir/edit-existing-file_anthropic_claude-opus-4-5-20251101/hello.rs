fn debug_args() {
    let args: Vec<String> = std::env::args().collect();
    println!("Debug: {} argument(s)", args.len());
    for (i, arg) in args.iter().enumerate() {
        println!("  [{}]: {}", i, arg);
    }
}

fn main() {
    debug_args();
    println!("Hello, world!");
}
