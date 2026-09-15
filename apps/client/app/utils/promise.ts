export const executeSeq = (promises: Array<() => Promise<any>>): Promise<any[]> => {
  const results: any[] = [];

  const chain = promises.reduce((previousPromise, currentPromiseFactory) => {
    return previousPromise.then(result => {
      if (result !== undefined) results.push(result);
      return currentPromiseFactory();
    });
  }, Promise.resolve());

  return chain.then(finalResult => {
    results.push(finalResult);
    return results;
  });
};
