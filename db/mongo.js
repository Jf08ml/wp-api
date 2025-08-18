// db/mongo.js
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

let _client;

export async function connectMongo() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGO_URI, {});
    await _client.connect();
  }
  return _client.db(); 
}

export default { connectMongo };
