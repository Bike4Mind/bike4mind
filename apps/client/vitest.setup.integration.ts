import mongoose from 'mongoose';
import { initModelsOnRequest } from '../../packages/database/src/__test__/initModelsOnRequest';

initModelsOnRequest(mongoose);
