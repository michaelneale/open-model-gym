fn debug_args(args: &[String]) {
    println!("Debug - All arguments:");
    for (i, arg) in args.iter().enumerate() {
        println!("  [{}]: {}", i, arg);
    }
}

fn main() {
    println!("Hello, world!");

    // Print all command line arguments
    let args: Vec<String> = std::env::args().collect();
    debug_args(&args);
}
