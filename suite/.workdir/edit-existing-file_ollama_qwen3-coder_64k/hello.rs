fn main() {
    println!("Hello, world!");
    
    // Debug function to print all arguments
    debug_args();
}

fn debug_args() {
    let args: Vec<String> = std::env::args().collect();
    println!("Arguments:");
    for (i, arg) in args.iter().enumerate() {
        println!("  {}: {}", i, arg);
    }
}
