interface IPagination {
  total: number;
  page: number;
  totalPages: number;
  pagePosition: 'first' | 'middle' | 'last';
}

export class Pagination {
  pageSize: number;
  pageNumber: number;

  constructor(pageSize: number, pageNumber: number) {
    this.pageSize = pageSize;
    this.pageNumber = pageNumber;
  }

  skip() {
    return (this.pageNumber - 1) * this.pageSize;
  }

  get(total: number): IPagination {
    const totalPages = Math.ceil(total / this.pageSize);

    let pagePosition: 'first' | 'middle' | 'last';
    if (this.pageNumber === 1) {
      pagePosition = 'first';
    } else if (this.pageNumber === totalPages) {
      pagePosition = 'last';
    } else {
      pagePosition = 'middle';
    }

    const result: IPagination = {
      total,
      page: this.pageNumber,
      totalPages,
      pagePosition,
    };

    return result;
  }
}
