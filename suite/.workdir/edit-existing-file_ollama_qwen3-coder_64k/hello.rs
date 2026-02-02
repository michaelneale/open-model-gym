use std::env;

fn main() {
    // Debug function to print all arguments
    fn debug_print_args() {
        let args: Vec<String> = env::args().collect();
        println!("Arguments count: {}", args.len());
        for (i, arg) in args.iter().enumerate() {
            println!("Argument {}: {}", i, arg);
        }
    }

    println!("Hello, world!");
    debug_print_args();
}
