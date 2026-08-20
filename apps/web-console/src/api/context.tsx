import { createContext, useContext } from "react";
import { api, type ApiClient } from "./client";
export const ApiContext = createContext<ApiClient>(api);
export const useApi = () => useContext(ApiContext);
