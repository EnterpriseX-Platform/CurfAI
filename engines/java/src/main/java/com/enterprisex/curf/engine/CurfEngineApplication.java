package com.enterprisex.curf.engine;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class CurfEngineApplication {

    public static void main(String[] args) {
        SpringApplication.run(CurfEngineApplication.class, args);
    }
}
