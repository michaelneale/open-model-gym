fn main() {
    debug_print_args();
    println!("Hello, world!");
}

fn debug_print_args() {
    // In Rust, we can't easily get all arguments like in other languages
    // This is a placeholder that shows how you might implement it
    println!("Debug: This function would print all arguments if we had them");
    // Note: Rust doesn't have direct access to command line arguments in this simple main function
    // To access arguments properly, you'd need to use std::env::args()
    // For demo purposes, we'll leave this placeholder
}
