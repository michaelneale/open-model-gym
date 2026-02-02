use std::env;

fn debug_args() {
    let args: Vec<String> = env::args().collect();
    println!("Debug: Program arguments:");
    for (i, arg) in args.iter().enumerate() {
        println!("  [{}]: {}", i, arg);
    }
}

fn main() {
    debug_args();
    println!("Hello, world!");
}
