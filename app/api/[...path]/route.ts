import { after } from "next/server";
import {getDb} from "@/lib/db";
import {getSessionUser} from "@/lib/auth/config";
import {handleApi} from "@/lib/http/api";
import {executeGroup} from "@/lib/orchestrator/run";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
async function route(request:Request,{params}:{params:Promise<{path:string[]}>}){
 try{
  const {path}=await params;
  return await handleApi(request,path,{db:getDb(),session:getSessionUser,schedule:id=>after(async()=>{await executeGroup(getDb(),id);})});
 }catch{return Response.json({error:{code:"service_unavailable"}},{status:503});}
}
export {route as GET,route as POST,route as PATCH};
