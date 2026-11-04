export async function register(){
 const {getEnv}=await import("./lib/env");
 getEnv();
}
