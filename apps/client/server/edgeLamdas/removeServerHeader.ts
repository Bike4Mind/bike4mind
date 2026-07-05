export const handler = async (event: any, context: any, callback: any) => {
  const response = event.Records[0].cf.response;
  delete response.headers['server'];
  callback(null, response);
};
